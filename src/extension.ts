// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CommentManager } from './commentManager';

// Interface for parsed diff hunks
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface CodeReviewSuggestion {
  filePath: string;
  // *** MODIFIED *** From a single line to a range
  startLine: number;
  endLine: number;
  suggestion: string;
  codeChange?: string; // Exact code replacement if possible, null if just a suggestion
}

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface LiteLLMResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}


interface CodeReview {
  summary: string;
  suggestions: CodeReviewSuggestion[];
}

interface ParsedDiff {
  filePath: string;
  status: string;
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
}

// Add this interface near the top with other interfaces
interface GitChange {
  uri: { fsPath: string };
  status: number;
  linesAdded?: number;
  linesDeleted?: number;
  additions?: number;
  deletions?: number;
}

// Git integration class
class GitIntegration {
  private gitExtension: any;
  private gitApi: any;
  private repository: any;
  private lastCommitSha: string | null = null;
  private sidebarProvider: CodeOwlSidebarProvider | null = null;
  private fileWatcher: vscode.FileSystemWatcher | null = null;

  constructor() {
    this.initializeGit();
    this.setupFileWatcher();
  }

  public setSidebarProvider(provider: CodeOwlSidebarProvider) {
    this.sidebarProvider = provider;
  }

  private async initializeGit() {
    try {
        console.log('🔍 Looking for vscode.git extension...');
        const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): any }>('vscode.git');
        if (!gitExtension) {
            console.error('❌ Git extension not found!');
            return;
        }

        console.log('✅ Git extension found. Activating and getting API...');
        await gitExtension.activate(); // Ensure it's active before getting the API
        this.gitApi = gitExtension.exports.getAPI(1);

        if (!this.gitApi) {
            console.error('❌ Could not get Git API from extension.');
            return;
        }

        console.log('✅ Git API obtained. Now attempting to find a repository...');
        
        // This is the robust "polling" mechanism.
        this.findAndSetupRepository(5); // Try to find a repo for 5 seconds (10 tries * 500ms)

        // Also listen for repositories opened later
        this.gitApi.onDidOpenRepository((repo: any) => {
            console.log('🎉 New repository opened:', repo.rootUri.path);
            if (!this.repository) {
                this.repository = repo;
                this.setupRepositoryListeners(repo);
            }
        });

    } catch (error) {
        console.error('❌ A critical error occurred during Git initialization:', error);
    }
  }

  private findAndSetupRepository(retriesLeft: number) {
    if (retriesLeft <= 0) {
        console.log('❌ Failed to find an open repository after multiple attempts.');
        return;
    }

    // Check if the API has found any repositories yet.
    if (this.gitApi && this.gitApi.repositories.length > 0) {
        console.log(`✅ Found ${this.gitApi.repositories.length} repositories.`);
        this.repository = this.gitApi.repositories[0];
        console.log('👍 Using repository:', this.repository.rootUri.fsPath);
        this.setupRepositoryListeners(this.repository);
    } else {
        // If not found, wait 500ms and try again.
        console.log(`⏳ No repository found. Retrying... (${retriesLeft} attempts left)`);
        setTimeout(() => this.findAndSetupRepository(retriesLeft - 1), 500);
    }
  }

  

  private handleApiInitialized() {
    if (!this.gitApi) return;
    
    // Check if we already assigned a repository. If so, do nothing.
    if (this.repository) {
        console.log('Repository already assigned. Initialization complete.');
        return;
    }

    if (this.gitApi.repositories.length > 0) {
        console.log(`✅ Git API is initialized and ${this.gitApi.repositories.length} repositories are found.`);
        this.repository = this.gitApi.repositories[0];
        console.log('👍 Using repository:', this.repository.rootUri.fsPath);
        this.setupRepositoryListeners(this.repository);
    } else {
         console.log('✅ Git API is initialized, but no repositories are currently open.');
    }
  }

  

  private setupRepositoryListeners(repo: any) {
    try {
      if (!repo || !repo.rootUri || !repo.state) {
        console.error('❌ Invalid repository in setupRepositoryListeners:', {
          hasRepo: !!repo,
          hasRootUri: repo?.rootUri ? 'yes' : 'no',
          hasState: repo?.state ? 'yes' : 'no'
        });
        return;
      }

      console.log('🎧 Setting up listeners for:', repo.rootUri.path);
      
      // Validate repository state
      if (typeof repo.state.onDidChange !== 'function') {
        console.error('❌ Repository state does not have onDidChange listener');
        return;
      }
      
      // Listen for state changes (commits, etc.)
      repo.state.onDidChange(() => {
        console.log('🔄 Repository state changed');
        this.handleRepositoryChange(repo).catch(error => {
          console.error('❌ Error in repository change handler:', error);
        });
      });

      // Initialize last commit tracking
      const head = repo.state.HEAD;
      if (head?.commit) {
        this.lastCommitSha = head.commit;
        console.log('📍 Initial commit SHA:', this.lastCommitSha);
      } else {
        console.log('⚠️ No initial commit found in repository');
      }

      console.log('✅ Git listeners set up successfully');
    } catch (error: any) {
      console.error('❌ Error setting up listeners:', error);
      console.error('Stack trace:', error.stack);
      vscode.window.showErrorMessage(`Error setting up git listeners: ${error.message}`);
    }
  }

  private async handleRepositoryChange(repo: any) {
    try {
      if (!repo || !repo.state) {
        console.error('❌ Invalid repository in handleRepositoryChange:', repo);
        return;
      }

      const head = repo.state.HEAD;
      console.log('📊 Repository state:', {
        hasHead: !!head,
        hasCommit: head?.commit ? 'yes' : 'no',
        headName: head?.name || 'unknown',
        lastKnownCommit: this.lastCommitSha || 'none'
      });

      if (head && head.commit) {
        console.log('📍 Current commit:', head.commit);
        
        // Check if this is a new commit (commit detection!)
        if (this.lastCommitSha && this.lastCommitSha !== head.commit) {
          console.log('🎉 NEW COMMIT DETECTED!');
          console.log('   - Previous:', this.lastCommitSha);
          console.log('   - Current:', head.commit);
          
          // Show popup notification for debugging
          vscode.window.showInformationMessage(`🎉 Commit detected: ${this.lastCommitSha.substring(0, 8)} → ${head.commit.substring(0, 8)}`);
          
          // This is where the magic happens - analyze the commit!
          vscode.window.showInformationMessage(`🔍 Analyzing new commit...`);
          await this.analyzeNewCommit(repo, this.lastCommitSha, head.commit);
        }
        
        // Update last commit tracking
        this.lastCommitSha = head.commit;
        
        // Get the diff for the latest changes (working tree)
        const changes = repo.state.workingTreeChanges || [];
        if (changes.length > 0) {
          console.log('📝 Working tree changes detected:', changes.length);
          await this.analyzeDiffs(repo, changes);
        }
      } else {
        console.log('⚠️ No HEAD or commit found in repository state');
      }
    } catch (error: any) {
      console.error('❌ Error handling repository change:', error);
      console.error('Stack trace:', error.stack);
      vscode.window.showErrorMessage(`Error handling repository change: ${error.message}`);
    }
  }

  // NEW: Analyze commits using a direct and correct approach
  // PASTE THIS COMPLETE FUNCTION INTO YOUR GitIntegration CLASS

  // NEW: Analyze commits using a direct and correct approach
  // PASTE THIS COMPLETE, CORRECTED FUNCTION INTO YOUR GitIntegration CLASS

  private async analyzeNewCommit(repo: any, previousCommit: string, newCommit:string) {
    try {
        console.log(`🔍 Analyzing commit diff between ${previousCommit.slice(0, 7)} and ${newCommit.slice(0, 7)}`);

        // PIVOT: Since .exec is not available, we try repo.diffWith().
        // This is a high-level function that returns a raw diff string.
        // It's our best alternative. We are asking for the diff of the *previous commit's content*
        // against the *current state*, which is the new commit.
        console.log('⚠️ .exec not found. Pivoting to repo.diffWith() as an alternative.');

        // This is a bit of a workaround. `diffWith` compares the working tree with a commit.
        // There isn't a direct `diffBetweenCommits` that returns a string.
        // A more complex but accurate way is to get the diff for each file.
        
        // Let's try getting the list of changed files first.
        const changedFiles = await repo.diffBetween(previousCommit, newCommit);

        if (!changedFiles || changedFiles.length === 0) {
            console.log('✅ No files changed between commits.');
            return;
        }

        console.log(`Found ${changedFiles.length} changed files. Generating diff for each.`);

        let fullDiffText = '';

        for (const change of changedFiles) {
            try {
                // For each file that changed, get its specific diff between the two commits.
                // This is the most accurate way to reconstruct the full diff.
                const fileDiff = await repo.diffBetween(previousCommit, newCommit, change.uri.fsPath);
                fullDiffText += fileDiff + '\n';
            } catch (diffError) {
                console.error(`Could not get diff for file ${change.uri.fsPath}`, diffError);
            }
        }

        if (!fullDiffText) {
            console.error('❌ Failed to generate any diff text from the changed files.');
            return;
        }

        // Now, we can use your excellent parser on the reconstructed diff text.
        const parsedDiffs = this.parseDiffText(fullDiffText);

        if (parsedDiffs.length === 0) {
            console.log('ℹ️ Diff parsing resulted in zero files.');
            return;
        }

        console.log(`✅ Successfully parsed diffs for ${parsedDiffs.length} files.`);

        this.sendCommitAnalysisToSidebar({
            type: 'commit',
            previousCommit: previousCommit.slice(0, 8),
            newCommit: newCommit.slice(0, 8),
            diffs: parsedDiffs,
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error('❌ Error in analyzeNewCommit using diffWith() pivot:', error);
        vscode.window.showErrorMessage(`Error during commit analysis: ${error.message}`);
    }
  }

  // Fallback method when commit diff fails
  private async analyzeWorkingTreeInstead(repo: any) {
    console.log('📋 Using working tree changes as fallback...');
    
    try {
      if (!repo || !repo.state) {
        console.error('❌ Invalid repository in analyzeWorkingTreeInstead:', repo);
        return;
      }

      const changes = repo.state.workingTreeChanges || [];
      console.log('📊 Working tree changes:', changes.length);

      if (changes.length === 0) {
        console.log('📭 No working tree changes to analyze');
        return;
      }

      const mockDiffs = [];
      
      for (const change of changes.slice(0, 3)) {
        try {
          if (!change || !change.uri) {
            console.log('⚠️ Invalid change object:', change);
            continue;
          }

          const filePath = change.uri?.path || '';
          const fileName = filePath ? filePath.split('/').pop() || 'unknown' : 'unknown';
          console.log('📄 Processing change for file:', fileName);
          
          mockDiffs.push({
            filePath: fileName,
            status: this.getStatusText(change.status),
            hunks: [{
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              lines: [
                { type: 'context', content: `File: ${fileName}`, oldLineNumber: 1, newLineNumber: 1 },
                { type: 'add', content: `Changes detected in ${fileName}`, newLineNumber: 2 }
              ]
            }],
            addedLines: 1,
            removedLines: 0
          });
        } catch (changeError) {
          console.error('❌ Error processing change:', changeError);
          continue;
        }
      }

      this.sendCommitAnalysisToSidebar({
        type: 'working-tree',
        previousCommit: 'working',
        newCommit: 'tree',
        diffs: mockDiffs,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error in fallback analysis:', error);
    }
  }

  // NEW: Parse diff text into structured hunks
  private parseDiffText(diffText: string): ParsedDiff[] {
    console.log('🔍 Parsing diff text...');
    
    if (!diffText || typeof diffText !== 'string' || diffText.length === 0) {
      return [];
    }
    
    const parsedDiffs: ParsedDiff[] = [];
    const lines = diffText.split('\n');
    
    console.log('📋 Processing', lines.length, 'lines for diff parsing');
    
    let currentFile: ParsedDiff | null = null;
    let currentHunk: DiffHunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;
    
    for (const line of lines) {
      // File header: diff --git a/file b/file
      if (line.startsWith('diff --git')) {
        // *** START OF THE FIX ***
        // If we were in the middle of a file, we need to finalize it.
        if (currentFile) {
            // First, add the last hunk to the file, if it exists.
            if (currentHunk) {
                currentFile.hunks.push(currentHunk);
                console.log('📊 Finalizing last hunk for file:', currentFile.filePath);
                currentHunk = null; // Reset for the new file
            }
            // THEN, add the completed file to our results.
            parsedDiffs.push(currentFile);
            console.log('📁 Added file to results:', currentFile.filePath);
        }
        // *** END OF THE FIX ***
        
        const fileParts = line.split(' ');
        const filePath = fileParts[3]?.substring(2) || fileParts[2]?.substring(2) || 'unknown'; // Handles spaces in filenames by checking index 3, fallback to 2
        
        currentFile = {
          filePath,
          status: 'modified',
          hunks: [],
          addedLines: 0,
          removedLines: 0
        };
        
        console.log('📁 Found new file header:', filePath);
        continue;
      }
      
      // File status
      if (line.startsWith('new file mode')) {
        if (currentFile) currentFile.status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        if (currentFile) currentFile.status = 'deleted';
        continue;
      }
      
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      if (line.startsWith('@@')) {
        // If we have a pending hunk, add it to the current file before starting a new one.
        if (currentHunk && currentFile) {
          currentFile.hunks.push(currentHunk);
          console.log('📊 Added hunk to file:', currentFile.filePath, 'with', currentHunk.lines.length, 'lines');
        }
        
        const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          const oldStart = parseInt(hunkMatch[1]);
          const oldCount = parseInt(hunkMatch[2] || '1');
          const newStart = parseInt(hunkMatch[3]);
          const newCount = parseInt(hunkMatch[4] || '1');
          
          currentHunk = {
            oldStart,
            oldCount,
            newStart,
            newCount,
            lines: []
          };
          
          oldLineNum = oldStart;
          newLineNum = newStart;
          console.log('📊 Found hunk header:', line);
        }
        continue;
      }
      
      // Diff content lines
      if (currentHunk && currentFile) {
        if (line.startsWith('+') && !line.startsWith('+++')) { // ignore +++ b/file line
          currentHunk.lines.push({ type: 'add', content: line.substring(1), newLineNumber: newLineNum });
          currentFile.addedLines++;
          newLineNum++;
        } else if (line.startsWith('-') && !line.startsWith('---')) { // ignore --- a/file line
          currentHunk.lines.push({ type: 'remove', content: line.substring(1), oldLineNumber: oldLineNum });
          currentFile.removedLines++;
          oldLineNum++;
        } else if (line.startsWith(' ')) {
          currentHunk.lines.push({ type: 'context', content: line.substring(1), oldLineNumber: oldLineNum, newLineNumber: newLineNum });
          oldLineNum++;
          newLineNum++;
        }
      }
    }
    
    // Add the very last file and its last hunk after the loop finishes
    if (currentFile) {
        if (currentHunk) {
            currentFile.hunks.push(currentHunk);
        }
        parsedDiffs.push(currentFile);
        console.log('📁 Added final file to results:', currentFile.filePath);
    }
    
    console.log('✅ Diff parsing complete! Returning', parsedDiffs.length, 'parsed diffs');
    
    return parsedDiffs;
  }

  private async analyzeDiffs(repo: any, changes: any[]) {
    console.log('🔍 Analyzing working tree diffs...');
    
    const diffResults = [];
    
    for (const change of changes) {
      try {
        const uri = change.uri;
        const diff = await repo.diffWithHEAD(uri.path);
        
        diffResults.push({
          file: uri.path,
          status: change.status,
          diff: diff
        });
        
        console.log(`📄 Diff for ${uri.path}:`, diff);
      } catch (error) {
        console.error('❌ Error getting diff:', error);
      }
    }
    
    // Send results to the sidebar
    this.sendDiffToSidebar(diffResults);
  }

  private sendDiffToSidebar(diffResults: any[]) {
    // We'll implement this to communicate with the sidebar
    console.log('📤 Sending diff results to sidebar:', diffResults);
  }

  // NEW: Send commit analysis to sidebar
  private sendCommitAnalysisToSidebar(analysis: any) {
    console.log('📤 Sending commit analysis to sidebar:', analysis);
    
    if (this.sidebarProvider) {
      this.sidebarProvider.updateCommitAnalysis(analysis);
    }
  }

  public async getRepositoryInfo() {
    console.log('📊 Getting repository info...');
    
    // THE FIX IS HERE:
    // If we don't have a repository, try to initialize it using the new helper.
    // This now checks the API state correctly instead of using the deleted function.
    if (!this.repository && this.gitApi && this.gitApi.state === 'initialized') {
      console.log('🔄 Repository not found, attempting to re-initialize from API state...');
      this.handleApiInitialized();
    }

    if (!this.repository) {
      console.log('❌ No repository available');
      
      const debugInfo = {
        gitExtensionAvailable: !!this.gitExtension,
        gitApiAvailable: !!this.gitApi,
        gitApiState: this.gitApi?.state || 'unavailable', // Add state for better debug
        repositoryCount: this.gitApi ? this.gitApi.repositories.length : 0,
        workspaceFolders: vscode.workspace.workspaceFolders?.length || 0
      };
      
      return { 
        status: 'No repository found',
        debug: debugInfo,
        suggestion: 'Make sure you have a git repository open in your workspace. Check the debug logs for API state.'
      };
    }

    try {
      const head = this.repository.state.HEAD;
      const changes = this.repository.state.workingTreeChanges;
      
      // Get git user name
      let userName = 'Unknown User';
      try {
        if (this.gitApi?.git?.path) {
          const { execFile } = require('child_process');
          const gitPath = this.gitApi.git.path;
          
          // Try to get git user name
          try {
            const result = await new Promise<string>((resolve, reject) => {
              execFile(gitPath, ['config', 'user.name'], { 
                cwd: this.repository.rootUri.fsPath 
              }, (error: any, stdout: string) => {
                if (error) reject(error);
                else resolve(stdout.trim());
              });
            });
            userName = result || 'Unknown User';
          } catch (gitError) {
            console.log('Could not get git user name:', gitError);
            userName = 'Unknown User';
          }
        }
      } catch (error) {
        console.log('Error getting git user name:', error);
      }
      
      console.log('✅ Repository info retrieved successfully');
      
      return {
        branch: head?.name || 'Unknown',
        commit: head?.commit || 'No commits',
        changedFiles: changes.length,
        repositoryPath: this.repository.rootUri.path,
        lastCommitSha: this.lastCommitSha,
        userName: userName,
        changes: changes.map((change: any) => ({
          file: change.uri.path,
          status: this.getStatusText(change.status)
        }))
      };
    } catch (error) {
      console.error('❌ Error getting repository info:', error);
      return { 
        status: 'Error reading repository: ' + String(error),
        repositoryPath: this.repository?.rootUri?.path || 'Unknown'
      };
    }
  }

  private getStatusText(status: number): string {
    switch (status) {
      case 0: return 'Untracked';
      case 1: return 'Added';
      case 2: return 'Modified';
      case 3: return 'Deleted';
      case 4: return 'Renamed';
      case 5: return 'Copied';
      case 6: return 'Unmerged';
      default: return 'Unknown';
    }
  }

  // Method to manually refresh git detection
  public async refreshGitDetection() {
    console.log('🔄 Manually refreshing git detection...');
    await this.initializeGit();
  }

  // Helper method to get git path
  private async getGitPath(): Promise<string | null> {
    try {
      if (this.gitApi && this.gitApi.git && this.gitApi.git.path) {
        return this.gitApi.git.path;
      }
      return 'git'; // Fallback to system git
    } catch (error) {
      console.log('❌ Could not get git path:', error);
      return null;
    }
  }

  private setupFileWatcher() {
    // Watch for file changes in the workspace, but exclude common irrelevant directories
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      '**/*', // Watch all files
      false, // Don't ignore creates
      false, // Don't ignore changes  
      false  // Don't ignore deletes
    );

    // Debounce function to avoid too many rapid updates
    let updateTimeout: NodeJS.Timeout | null = null;

    const scheduleUpdate = (uri: vscode.Uri) => {
      // Filter out irrelevant files to avoid unnecessary updates
      const path = uri.fsPath;
      if (path.includes('node_modules') || 
          path.includes('.git') || 
          path.includes('.vscode') ||
          path.includes('out') ||
          path.includes('dist') ||
          path.endsWith('.log')) {
        return; // Skip these files
      }

      if (updateTimeout) {
        clearTimeout(updateTimeout);
      }
      updateTimeout = setTimeout(() => {
        this.refreshRepositoryInfo();
      }, 300); // Faster response: 300ms
    };

    this.fileWatcher.onDidCreate(scheduleUpdate);
    this.fileWatcher.onDidChange(scheduleUpdate);
    this.fileWatcher.onDidDelete(scheduleUpdate);

    console.log('✅ File system watcher set up for immediate change detection');
  }

  private async refreshRepositoryInfo() {
    if (this.sidebarProvider && this.repository) {
      try {
        console.log('🔄 Refreshing repository info due to file changes...');
        const gitInfo = await this.getRepositoryInfo();
        this.sidebarProvider.updateGitInfo(gitInfo);
      } catch (error) {
        console.error('❌ Error refreshing repository info:', error);
      }
    }
  }

  // Clean up resources
  public dispose() {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      console.log('🧹 File system watcher disposed');
    }
  }
}

// WebView Provider for the CodeOwl AI sidebar
class CodeOwlSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeowlSidebar';

  private _view?: vscode.WebviewView;
  private gitIntegration: GitIntegration;
  private commentManager: CommentManager;
  private isReviewing: boolean = false;
  private reviewResults: CodeReview | null = null;

  constructor(private readonly _extensionUri: vscode.Uri, gitIntegration: GitIntegration, commentManager: CommentManager) {
    this.gitIntegration = gitIntegration;
    this.commentManager = commentManager;
  }

  public updateCommitAnalysis(analysis: any) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'showCommitAnalysis',
        analysis: analysis
      });
    }
  }

  public updateGitInfo(gitInfo: any) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'updateGitInfo',
        gitInfo: gitInfo
      });
    }
  }

  private async performWorkingTreeReview(files: any[]): Promise<CodeReview> {
    console.log("🤖 Performing working tree AI code review using Gemini...");
    
    // Get the API key from VS Code settings
    const config = vscode.workspace.getConfiguration('codeowl');
    let apiKey = config.get<string>('geminiApiKey');
    
    if (!apiKey) {
      const key = await vscode.window.showInputBox({
        prompt: 'Please enter your Gemini API key',
        password: true,
        placeHolder: 'Enter your Gemini API key here'
      });

      if (key) {
        await config.update('geminiApiKey', key, vscode.ConfigurationTarget.Global);
        apiKey = key;
        console.log('✅ API key saved to settings');
      } else {
        const message = 'Gemini API key is required for code review functionality.';
        console.error(message);
        vscode.window.showErrorMessage(message);
        throw new Error(message);
      }
    }
    
    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    let prompt = `You are an expert code reviewer. Analyze the following modified files and provide detailed, specific feedback on code quality, potential bugs, performance issues, and best practices.

For each suggestion:
- ALWAYS specify the exact file path.
- ALWAYS include the start and end line numbers for the code block the suggestion applies to.
- Be specific and actionable in your recommendations.
- Focus on meaningful issues, not trivial style preferences.

IMPORTANT: Respond with ONLY a valid JSON object, no markdown formatting, no backticks, no explanation text.

Files to review:

`;

    // Get content for each file
    for (const file of files) {
      try {
        const uri = vscode.Uri.file(file.path);
        const document = await vscode.workspace.openTextDocument(uri);
        const content = document.getText();
        const lines = content.split('\n');
        
        prompt += `=== File: ${file.relativePath} ===\n`;
        prompt += `Status: ${file.status}\n`;
        prompt += `Content (with line numbers):\n`;
        
        lines.forEach((line, index) => {
          prompt += `${index + 1}: ${line}\n`;
        });
        
        prompt += "\n";
      } catch (error) {
        console.error(`Error reading file ${file.path}:`, error);
        prompt += `=== File: ${file.relativePath} ===\n`;
        prompt += `Status: ${file.status}\n`;
        prompt += `Error: Could not read file content\n\n`;
      }
    }

    prompt += `\nRespond with a JSON object in this exact format (no markdown, no backticks):
{
  "summary": "A high-level overview of the code quality and key findings",
  "suggestions": [
    {
      "filePath": "exact/relative/path/to/file.ext",
      "startLine": 120,
      "endLine": 125,
      "suggestion": "Detailed explanation of the issue and recommended improvement",
      "codeChange": "exact replacement code for the specified lines (if you can provide it) or null if just a general suggestion"
    }
  ]
}

IMPORTANT: 
- Use the exact relative file paths as provided
- Line numbers must match the numbered content above
- If you can provide exact code replacement, include it in "codeChange"
- If it's just a general suggestion without specific code, set "codeChange" to null
- Focus on substantial improvements, not minor style issues`;

    console.log("📝 Generated prompt for working tree review");

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      let content = response.text();

      content = content.replace(/\`\`\`json\n?|\`\`\`\n?/g, '').trim();

      console.log("✅ Received Gemini response:", content);

      try {
        const review = JSON.parse(content) as CodeReview;
        console.log("📊 Parsed review:", review);
        return review;
      } catch (parseError) {
        console.error("Error parsing Gemini response as JSON:", parseError);
        console.error("Raw response:", content);
        return {
          summary: "Failed to parse AI response as JSON. Raw feedback follows:",
          suggestions: [{
            filePath: files[0]?.relativePath || "unknown",
            startLine: 1,
            endLine: 1,
            suggestion: content
          }]
        };
      }
    } catch (error) {
      console.error("Error calling Gemini:", error);
      throw error;
    }
  }

  private async performCodeReview(analysis: { diffs: ParsedDiff[] }): Promise<CodeReview> {
    console.log("🤖 Performing AI code review using Gemini...");
    
    // Get the API key from VS Code settings
    const config = vscode.workspace.getConfiguration('codeowl');
    let apiKey = config.get<string>('geminiApiKey');
    
    if (!apiKey) {
      // If API key is not found, prompt the user to enter it
      const key = await vscode.window.showInputBox({
        prompt: 'Please enter your Gemini API key',
        password: true, // This will mask the input
        placeHolder: 'Enter your Gemini API key here'
      });

      if (key) {
        // Save the API key to VS Code settings
        await config.update('geminiApiKey', key, vscode.ConfigurationTarget.Global);
        apiKey = key;
        console.log('✅ API key saved to settings');
      } else {
        const message = 'Gemini API key is required for code review functionality.';
        console.error(message);
        vscode.window.showErrorMessage(message);
        throw new Error(message);
      }
    }
    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Step 1: Format the diffs into a prompt for the LLM
    let prompt = `You are an expert code reviewer. Analyze the following git diff and provide detailed, specific feedback.

For each suggestion:
- ALWAYS specify the exact file path.
- ALWAYS include the start and end line numbers for the code block the suggestion applies to. If it's a single line, startLine and endLine should be the same.
- Be specific and actionable in your recommendations.

IMPORTANT: Respond with ONLY a valid JSON object, no markdown formatting, no backticks, no explanation text.

Here is the diff to analyze:

`;

    for (const fileDiff of analysis.diffs) {
      prompt += `=== File: ${fileDiff.filePath} ===\n`;
      for (const hunk of fileDiff.hunks) {
        prompt += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
        for (const line of hunk.lines) {
          if (line.type === 'add') {
            prompt += `+ (Line ${line.newLineNumber}) ${line.content}\n`;
          } else if (line.type === 'remove') {
            prompt += `- (Line ${line.oldLineNumber}) ${line.content}\n`;
          } else {
            prompt += `  ${line.content}\n`;
          }
        }
      }
      prompt += "\n";
    }

    prompt += `\nRespond with a JSON object in this exact format (no markdown, no backticks):
{
  "summary": "A high-level overview of the changes and their impact",
  "suggestions": [
    {
      "filePath": "exact/path/to/file.ext",
      "startLine": 120,
      "endLine": 125,
      "suggestion": "Detailed explanation of the issue and why it should be changed",
      "codeChange": "exact replacement code for the specified lines (if you can provide it) or null if just a general suggestion"
    }
  ]
}

IMPORTANT: 
- If you can provide exact code replacement, include it in "codeChange"
- If it's just a general suggestion without specific code, set "codeChange" to null
- The "suggestion" field should always explain the reasoning, even if you provide exact code`;

    console.log("📝 Generated prompt:", prompt);

    try {
      // Generate content using Gemini
      const result = await model.generateContent(prompt);
      const response = await result.response;
      let content = response.text();

      // Clean up any potential markdown formatting
      content = content.replace(/\`\`\`json\n?|\`\`\`\n?/g, '').trim();

      console.log("✅ Received Gemini response:", content);

      // Parse the JSON response
      try {
        const review = JSON.parse(content) as CodeReview;
        console.log("📊 Parsed review:", review);
        return review;
      } catch (parseError) {
        console.error("Error parsing Gemini response as JSON:", parseError);
        console.error("Raw response:", content);
        // Fallback: Create a structured response from the raw text
        return {
          summary: "Failed to parse AI response as JSON. Raw feedback follows:",
          suggestions: [{
            filePath: analysis.diffs[0]?.filePath || "unknown",
            startLine: 1,
            endLine: 1,
            suggestion: content
          }]
        };
      }
    } catch (error) {
      console.error("Error calling Gemini:", error);
      throw error;
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'startWorkingTreeReview':
          if (message.files && message.files.length > 0) {
            this.isReviewing = true;
            webviewView.webview.postMessage({ command: 'reviewStarted' });
            
            try {
              const review = await this.performWorkingTreeReview(message.files);
              
              // Display the review as VS Code comments
              await this.commentManager.displayReviewsAsComments(review);
              
              // Send the results back to the webview
              this.reviewResults = review;
              webviewView.webview.postMessage({ 
                command: 'reviewCompleted', 
                review: review 
              });
            } catch (error) {
              console.error('Error during working tree review:', error);
              webviewView.webview.postMessage({ 
                command: 'reviewError', 
                error: 'Failed to complete review: ' + (error as Error).message 
              });
            } finally {
              this.isReviewing = false;
            }
          } else {
            vscode.window.showWarningMessage("No files to review.");
          }
          break;

        case 'startCommitReview':
          // *** NEW *** The user wants to start a code review.
          if (message.analysis) {
              this.isReviewing = true;
              webviewView.webview.postMessage({ command: 'reviewStarted' });
              
              try {
                // 2. Perform the review (currently a mock).
                const review = await this.performCodeReview(message.analysis);
                
                // 3. Display the review as VS Code comments
                await this.commentManager.displayReviewsAsComments(review);
                
                // 4. Send the results back to the webview.
                this.reviewResults = review;
                webviewView.webview.postMessage({ command: 'reviewCompleted', review: review });
              } catch (error) {
                console.error('Error during commit review:', error);
                webviewView.webview.postMessage({ 
                  command: 'reviewError', 
                  error: 'Failed to complete review: ' + (error as Error).message 
                });
              } finally {
                this.isReviewing = false;
              }
          } else {
              vscode.window.showWarningMessage("No commit data available to review. A new commit must be detected first.");
          }
          break;
  
        case 'getGitInfo':
          const gitInfo = await this.gitIntegration.getRepositoryInfo();
          webviewView.webview.postMessage({ command: 'updateGitInfo', gitInfo: gitInfo });
          break;

        case 'goToComment':
          if (message.commentIndex !== undefined && this.reviewResults) {
            const suggestion = this.reviewResults.suggestions[message.commentIndex];
            if (suggestion) {
              // Open file and navigate to the line
              const fileUris = await vscode.workspace.findFiles(`**/${suggestion.filePath}`, '**/node_modules/**', 1);
              if (fileUris.length > 0) {
                const document = await vscode.workspace.openTextDocument(fileUris[0]);
                const editor = await vscode.window.showTextDocument(document);
                const position = new vscode.Position(suggestion.startLine - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
              }
            }
          }
          break;
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: linear-gradient(135deg, var(--vscode-editor-background) 0%, var(--vscode-sideBar-background) 100%);
            color: var(--vscode-editor-foreground);
            min-height: 100vh;
            overflow-x: hidden;
          }

          .app-container {
            padding: 5px; /* Reduced from 20px */
            max-width: 100%;
            min-width: 280px; /* Minimum width to prevent cluttering */
          }

          .header {
            text-align: center;
            margin-bottom: 30px;
            animation: fadeInDown 0.6s ease-out;
          }

          .logo {
            font-size: 42px;
            margin-bottom: 12px;
            filter: drop-shadow(0 4px 8px rgba(0,0,0,0.3));
          }

          .title {
            font-size: 28px;
            font-weight: 700;
            background: linear-gradient(45deg, var(--vscode-textLink-foreground), #7C3AED);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
          }

          .subtitle {
            font-size: 14px;
            opacity: 0.7;
            margin-bottom: 20px;
          }

          .card {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            padding: 16px; /* Reduced padding for smaller screens */
            margin-bottom: 16px; /* Reduced margin */
            backdrop-filter: blur(10px);
            transition: all 0.3s ease;
            animation: slideInUp 0.6s ease-out;
          }

          .card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.15);
          }

          .card-header {
            display: flex;
            align-items: center;
            gap: 10px; /* Reduced gap */
            margin-bottom: 12px; /* Reduced margin */
            font-weight: 600;
            font-size: 15px; /* Slightly smaller font */
          }

          .card-icon {
            font-size: 20px;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
          }

          .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
          }

          .status-connected {
            background: rgba(34, 197, 94, 0.2);
            color: #22c55e;
            border: 1px solid rgba(34, 197, 94, 0.3);
          }

          .status-error {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.3);
          }

          .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
          }

          .info-row:last-child {
            border-bottom: none;
          }

          .info-label {
            font-weight: 500;
            opacity: 0.8;
          }

          .info-value {
            font-family: 'Monaco', 'Consolas', monospace;
            background: rgba(255,255,255,0.1);
            padding: 2px 8px;
            border-radius: 6px;
            font-size: 12px;
          }

          .file-list {
            max-height: 200px;
            overflow-y: auto;
            margin: 15px 0;
          }

          .file-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 12px;
            margin: 4px 0;
            background: rgba(255,255,255,0.05);
            border-radius: 8px;
            transition: all 0.2s ease;
          }

          .file-item:hover {
            background: rgba(255,255,255,0.1);
            transform: translateX(4px);
          }

          .file-icon {
            font-size: 16px;
          }

          .file-name {
            flex: 1;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 13px;
          }

          .file-status {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            font-weight: bold;
          }

          .status-modified { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
          .status-added { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
          .status-deleted { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
          .status-untracked { background: rgba(156, 163, 175, 0.2); color: #9ca3af; }

          .btn {
            background: linear-gradient(135deg, var(--vscode-button-background), var(--vscode-textLink-foreground));
            color: white;
            border: none;
            padding: 10px 20px; /* Reduced padding */
            border-radius: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            width: 100%;
            font-size: 13px; /* Smaller font for better fit */
            position: relative;
            overflow: hidden;
          }

          .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(var(--vscode-textLink-foreground), 0.3);
          }

          .btn:active {
            transform: translateY(0);
          }

          .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
          }

          .btn-secondary {
            background: rgba(255,255,255,0.1);
            color: var(--vscode-editor-foreground);
            border: 1px solid rgba(255,255,255,0.2);
          }

          .loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.8);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            backdrop-filter: blur(4px);
            padding: 12px; /* Match reduced container padding */
          }

          .loading-content {
            text-align: center;
            padding: 30px; /* Reduced padding */
            background: var(--vscode-editor-background);
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.2);
            box-shadow: 0 15px 30px rgba(0,0,0,0.3);
            max-width: 280px; /* Ensure it fits in sidebar */
            width: 90%;
          }

          .loading-animation {
            position: relative;
            width: 50px; /* Smaller, simpler */
            height: 50px;
            margin: 0 auto 15px; /* Reduced margin */
          }

          .loading-ring {
            position: absolute;
            width: 100%;
            height: 100%;
            border: 2px solid transparent;
            border-top: 2px solid var(--vscode-textLink-foreground);
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }

          /* Remove extra rings for simplicity */
          .loading-ring:nth-child(2),
          .loading-ring:nth-child(3) {
            display: none;
          }

          .loading-text {
            font-size: 14px; /* Smaller text */
            font-weight: 600;
            margin-bottom: 6px;
            color: var(--vscode-textLink-foreground);
          }

          .loading-subtext {
            font-size: 12px; /* Smaller subtext */
            opacity: 0.7;
          }

          .review-results {
            display: none;
            animation: slideInUp 0.6s ease-out;
          }

          .success-message {
            text-align: center;
            padding: 40px;
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid rgba(34, 197, 94, 0.3);
            border-radius: 16px;
            margin-bottom: 20px;
          }

          .success-icon {
            font-size: 48px;
            margin-bottom: 16px;
          }

          .comment-list {
            max-height: 300px;
            overflow-y: auto;
          }

          .comment-item {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 12px;
            transition: all 0.3s ease;
            cursor: pointer;
          }

          .comment-item:hover {
            background: rgba(255,255,255,0.1);
            transform: translateX(4px);
          }

          .comment-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
          }

          .comment-file {
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 12px;
            color: var(--vscode-textLink-foreground);
            font-weight: 600;
          }

          .comment-line {
            font-size: 11px;
            background: rgba(255,255,255,0.1);
            padding: 2px 6px;
            border-radius: 4px;
          }

          .comment-text {
            font-size: 13px;
            line-height: 1.5;
            opacity: 0.9;
          }

          .empty-state {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.7;
          }

          .empty-icon {
            font-size: 32px;
            margin-bottom: 16px;
          }

          .hidden {
            display: none !important;
          }

          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }

          @keyframes bounce {
            0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
            40% { transform: translateY(-10px); }
            60% { transform: translateY(-5px); }
          }

          @keyframes fadeInDown {
            from {
              opacity: 0;
              transform: translateY(-20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          @keyframes slideInUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          .pulse {
            animation: pulse 2s infinite;
          }

          @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
          }

          /* Scrollbar styling */
          ::-webkit-scrollbar {
            width: 8px;
          }

          ::-webkit-scrollbar-track {
            background: rgba(255,255,255,0.1);
            border-radius: 4px;
          }

          ::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.3);
            border-radius: 4px;
          }

          ::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.5);
          }

          /* Media query for very small sidebar widths */
          @media (max-width: 320px) {
            .app-container {
              padding: 4px; /* Further reduced padding */
              min-width: 260px;
            }
            
            .card {
              padding: 12px;
              margin-bottom: 12px;
              border-radius: 12px;
            }
            
            .card-header {
              font-size: 14px;
              gap: 8px;
              margin-bottom: 10px;
            }
            
            .title {
              font-size: 24px;
            }
            
            .btn {
              padding: 8px 16px;
              font-size: 12px;
            }
            
            .info-row {
              padding: 6px 0;
            }
            
            .file-item {
              padding: 6px 10px;
            }
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="header">
            <div class="logo">🦉</div>
            <div class="title">CodeOwl AI</div>
            <div class="subtitle">Intelligent Code Review Assistant</div>
          </div>

          <div class="card" id="git-section">
            <div class="card-header">
              <span class="card-icon">👤</span>
              <span>Account & Repository</span>
            </div>
            <div id="git-info">
              <div class="empty-state">
                <div class="empty-icon pulse">🔄</div>
                <div>Loading repository information...</div>
              </div>
            </div>
          </div>

          <div class="card" id="files-section" style="display: none;">
            <div class="card-header">
              <span class="card-icon">📁</span>
              <span>Files to Review</span>
            </div>
            <div id="files-list" class="file-list"></div>
            <button class="btn" id="start-review-btn" onclick="startReview()" disabled>
              🤖 Start AI Review
            </button>
          </div>

          <div class="card hidden" id="commit-section">
            <div class="card-header">
              <span class="card-icon">🎉</span>
              <span>New Commit Detected</span>
            </div>
            <div id="commit-details"></div>
            <button class="btn" onclick="startCommitReview()">🤖 Review Commit Changes</button>
          </div>

          <div class="card hidden" id="results-section">
            <div class="card-header">
              <span class="card-icon">📋</span>
              <span>Review Results</span>
            </div>
            <div id="review-content"></div>
          </div>
        </div>

        <!-- Loading Overlay -->
        <div class="loading-overlay" id="loading-overlay">
          <div class="loading-content">
            <div class="loading-animation">
              <div class="loading-ring"></div>
            </div>
            <div class="loading-text">CodeOwl is analyzing your code...</div>
            <div class="loading-subtext">This may take a few moments</div>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          let currentFilesToReview = [];
          let currentCommitAnalysis = null;
          let currentReviewResults = null;

          // Initialize
          document.addEventListener('DOMContentLoaded', () => {
            refreshGitInfo();
          });

          function refreshGitInfo() {
            vscode.postMessage({ command: 'getGitInfo' });
          }

          function startReview() {
            if (currentFilesToReview.length > 0) {
              // Update button to show it's starting
              const btn = document.getElementById('start-review-btn');
              btn.disabled = true;
              btn.textContent = '🔄 Starting Review...';
              
              vscode.postMessage({
                command: 'startWorkingTreeReview',
                files: currentFilesToReview
              });
            }
          }

          function startCommitReview() {
            if (currentCommitAnalysis) {
              vscode.postMessage({
                command: 'startCommitReview',
                analysis: currentCommitAnalysis
              });
            }
          }

          function goToComment(index) {
            vscode.postMessage({
              command: 'goToComment',
              commentIndex: index
            });
          }

          // Message handling
          window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
              case 'updateGitInfo':
                updateGitDisplay(message.gitInfo);
                break;
              case 'showCommitAnalysis':
                currentCommitAnalysis = message.analysis;
                showCommitAnalysis(message.analysis);
                break;
              case 'reviewStarted':
                showLoading();
                break;
              case 'reviewCompleted':
                hideLoading();
                // Re-enable the start review button
                const btn = document.getElementById('start-review-btn');
                if (currentFilesToReview.length > 0) {
                  btn.disabled = false;
                  btn.textContent = '🤖 Start AI Review';
                }
                showReviewResults(message.review);
                break;
              case 'reviewError':
                hideLoading();
                // Re-enable the start review button
                const errorBtn = document.getElementById('start-review-btn');
                if (currentFilesToReview.length > 0) {
                  errorBtn.disabled = false;
                  errorBtn.textContent = '🤖 Start AI Review';
                }
                showError(message.error);
                break;
            }
          });

          function showLoading() {
            document.getElementById('loading-overlay').style.display = 'flex';
          }

          function hideLoading() {
            document.getElementById('loading-overlay').style.display = 'none';
          }

          function updateGitDisplay(gitInfo) {
            const gitInfoElement = document.getElementById('git-info');
            const filesSection = document.getElementById('files-section');
            
            if (gitInfo.status) {
              // Error state
              gitInfoElement.innerHTML = \`
                <div class="info-row">
                  <span class="status-indicator status-error">❌ \${gitInfo.status}</span>
                </div>
                \${gitInfo.suggestion ? \`<div style="margin-top: 15px; padding: 12px; background: rgba(59, 130, 246, 0.1); border-radius: 8px; font-size: 14px;">💡 \${gitInfo.suggestion}</div>\` : ''}
              \`;
              filesSection.style.display = 'none';
              return;
            }

            // Success state
            const userName = gitInfo.userName || 'Unknown User';
            gitInfoElement.innerHTML = \`
              <div class="info-row">
                <span class="info-label">Status</span>
                <span class="status-indicator status-connected">✅ Connected</span>
              </div>
              <div class="info-row">
                <span class="info-label">User</span>
                <span class="info-value">👤 \${userName}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Branch</span>
                <span class="info-value">🌿 \${gitInfo.branch}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Latest Commit</span>
                <span class="info-value">📍 \${gitInfo.commit.substring(0, 8)}</span>
              </div>
            \`;

            // Always show files section and update content
            if (gitInfo.changes && gitInfo.changes.length > 0) {
              // Files to review exist
              currentFilesToReview = gitInfo.changes.map(change => ({
                path: change.file,
                relativePath: change.file.split('/').pop(),
                status: change.status.toLowerCase()
              }));

              let filesHtml = '';
              gitInfo.changes.forEach(change => {
                const fileName = change.file.split('/').pop();
                const statusClass = \`status-\${change.status.toLowerCase()}\`;
                filesHtml += \`
                  <div class="file-item">
                    <span class="file-icon">📄</span>
                    <span class="file-name">\${fileName}</span>
                    <span class="file-status \${statusClass}">\${change.status}</span>
                  </div>
                \`;
              });

              document.getElementById('files-list').innerHTML = filesHtml;
              document.getElementById('start-review-btn').disabled = false;
              document.getElementById('start-review-btn').textContent = '🤖 Start AI Review';
              filesSection.style.display = 'block';
            } else {
              // No files to review
              document.getElementById('files-list').innerHTML = \`
                <div class="empty-state" style="padding: 20px; text-align: center; opacity: 0.7;">
                  <div style="font-size: 24px; margin-bottom: 8px;">✨</div>
                  <div style="font-size: 14px;">No uncommitted changes found</div>
                  <div style="font-size: 12px; margin-top: 4px;">Make some changes to see them here</div>
                </div>
              \`;
              document.getElementById('start-review-btn').disabled = true;
              document.getElementById('start-review-btn').textContent = '📭 No Files to Review';
              filesSection.style.display = 'block'; // Still show the section
              currentFilesToReview = [];
            }
          }

          function showCommitAnalysis(analysis) {
            const commitSection = document.getElementById('commit-section');
            const commitDetails = document.getElementById('commit-details');
            
            // Clear previous review results when new commit is detected
            const resultsSection = document.getElementById('results-section');
            resultsSection.classList.add('hidden');
            currentReviewResults = null;
            
            commitSection.classList.remove('hidden');
            
            const html = \`
              <div class="info-row">
                <span class="info-label">Commit</span>
                <span class="info-value">\${analysis.previousCommit} → \${analysis.newCommit}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Time</span>
                <span class="info-value">\${new Date(analysis.timestamp).toLocaleTimeString()}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Files Changed</span>
                <span class="info-value">\${analysis.diffs.length} files</span>
              </div>
            \`;
            
            commitDetails.innerHTML = html;
          }

          function showReviewResults(review) {
            currentReviewResults = review;
            const resultsSection = document.getElementById('results-section');
            const reviewContent = document.getElementById('review-content');
            
            resultsSection.classList.remove('hidden');

            if (!review.suggestions || review.suggestions.length === 0) {
              reviewContent.innerHTML = \`
                <div class="success-message">
                  <div class="success-icon">🎉</div>
                  <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">Hurray! No Issues Found</div>
                  <div style="opacity: 0.8;">Your code looks great! No suggestions for improvement.</div>
                </div>
              \`;
            } else {
              let html = \`
                <div style="margin-bottom: 20px; padding: 16px; background: rgba(59, 130, 246, 0.1); border-radius: 12px;">
                  <strong>📋 Summary:</strong> \${review.summary}
                </div>
                <div style="margin-bottom: 16px;">
                  <strong>\${review.suggestions.length}</strong> suggestion\${review.suggestions.length === 1 ? '' : 's'} found and added as comments in your code:
                </div>
                <div class="comment-list">
              \`;

              review.suggestions.forEach((suggestion, index) => {
                html += \`
                  <div class="comment-item" onclick="goToComment(\${index})">
                    <div class="comment-header">
                      <span class="comment-file">📄 \${suggestion.filePath}</span>
                      <span class="comment-line">Lines \${suggestion.startLine}-\${suggestion.endLine}</span>
                    </div>
                    <div class="comment-text">\${suggestion.suggestion}</div>
                  </div>
                \`;
              });

              html += '</div>';
              reviewContent.innerHTML = html;
            }
          }

          function showError(error) {
            const resultsSection = document.getElementById('results-section');
            const reviewContent = document.getElementById('review-content');
            
            resultsSection.classList.remove('hidden');
            reviewContent.innerHTML = \`
              <div style="text-align: center; padding: 40px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 16px;">
                <div style="font-size: 32px; margin-bottom: 16px;">❌</div>
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">Review Failed</div>
                <div style="opacity: 0.8;">\${error}</div>
              </div>
            \`;
          }
        </script>
      </body>
      </html>`;
    }
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  console.log('CodeOwl AI extension is now active!');

  // Initialize Git Integration
  const gitIntegration = new GitIntegration();

  // Initialize Comment Manager
  const commentManager = new CommentManager(context.extensionUri);

  // Register the sidebar provider
  const provider = new CodeOwlSidebarProvider(context.extensionUri, gitIntegration, commentManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CodeOwlSidebarProvider.viewType, provider)
  );

  // Link the sidebar provider to git integration for communication
  gitIntegration.setSidebarProvider(provider);

  // Register the command to open sidebar
  let disposable = vscode.commands.registerCommand('codeowl.openSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.codeowl');
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(commentManager);
  
  // Register GitIntegration for proper cleanup
  context.subscriptions.push({
    dispose: () => gitIntegration.dispose()
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
