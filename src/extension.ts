// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

interface CodeReviewSuggestion {
  filePath: string;
  lineNumber: number;
  suggestion: string;
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

  constructor() {
    this.initializeGit();
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
      
      console.log('✅ Repository info retrieved successfully');
      
      return {
        branch: head?.name || 'Unknown',
        commit: head?.commit || 'No commits',
        changedFiles: changes.length,
        repositoryPath: this.repository.rootUri.path,
        lastCommitSha: this.lastCommitSha,
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
}

// WebView Provider for the CodeOwl AI sidebar
class CodeOwlSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeowlSidebar';

  private _view?: vscode.WebviewView;
  private gitIntegration: GitIntegration;

  constructor(private readonly _extensionUri: vscode.Uri, gitIntegration: GitIntegration) {
    this.gitIntegration = gitIntegration;
  }

  public updateCommitAnalysis(analysis: any) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'showCommitAnalysis',
        analysis: analysis
      });
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
      "suggestion": "Detailed suggestion for this block of code with an explanation."
    }
  ]
}`;

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
            lineNumber: 1,
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
      case 'startCodeReview':
          // *** NEW *** The user wants to start a code review.
          if (message.analysis) {
              // 1. Let the webview know we're working on it.
              webviewView.webview.postMessage({ command: 'showCodeReview', status: 'loading' });
              
              // 2. Perform the review (currently a mock).
              const review = await this.performCodeReview(message.analysis);
              
              // 3. Send the results back to the webview.
              webviewView.webview.postMessage({ command: 'showCodeReview', status: 'complete', review: review });
          } else {
              vscode.window.showWarningMessage("No commit data available to review. A new commit must be detected first.");
          }
          break;
  
      case 'getGitInfo':
          const gitInfo = await this.gitIntegration.getRepositoryInfo();
          webviewView.webview.postMessage({ command: 'updateGitInfo', gitInfo: gitInfo });
          break;
  
      case 'debugGit':
          await this.gitIntegration.refreshGitDetection();
          const debugInfo = await this.gitIntegration.getRepositoryInfo();
          webviewView.webview.postMessage({ command: 'updateGitInfo', gitInfo: debugInfo });
          break;
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // *** MODIFIED *** The HTML and JavaScript have been updated significantly.
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          /* (Styles from before are kept, with additions) */
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; margin: 0; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
          .welcome-container { text-align: center; padding: 20px 0; }
          .logo { font-size: 48px; margin-bottom: 20px; }
          .title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: var(--vscode-textLink-foreground); }
          .subtitle { font-size: 16px; opacity: 0.8; margin-bottom: 30px; }
          .button { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
          .button:hover { background-color: var(--vscode-button-hoverBackground); }
          .section { margin-top: 30px; padding: 15px; background-color: var(--vscode-editor-selectionBackground); border-radius: 8px; text-align: left; }
          .section-title { font-size: 18px; font-weight: bold; margin-bottom: 10px; color: var(--vscode-textLink-foreground); }
          .git-info { font-size: 14px; margin: 5px 0; }
          .commit-analysis { display: none; } /* Hide by default */
          .diff-file { margin: 10px 0; border: 1px solid var(--vscode-panel-border); border-radius: 5px; overflow: hidden; }
          .diff-header { padding: 8px 12px; background-color: var(--vscode-editor-background); font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
          .diff-stats { font-size: 12px; color: var(--vscode-textLink-foreground); }
          .diff-hunk { margin: 5px 0; font-family: 'Monaco', 'Consolas', monospace; font-size: 12px; }
          .diff-line { padding: 2px 8px; line-height: 1.3; }
          .diff-add { background-color: rgba(46, 160, 67, 0.2); }
          .diff-remove { background-color: rgba(248, 81, 73, 0.2); }
          .diff-context { opacity: 0.7; }
          .commit-summary { display: flex; justify-content: space-between; margin-bottom: 15px; padding: 10px; background-color: var(--vscode-editor-background); border-radius: 5px; }
          
          /* *** NEW STYLES for Code Review Section *** */
          .review-suggestion {
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding: 10px;
            margin: 15px 0;
            background-color: var(--vscode-editor-background);
            border-radius: 0 5px 5px 0;
          }
          .review-file-info {
            font-weight: bold;
            font-size: 13px;
            margin-bottom: 8px;
          }
          .review-text {
            font-size: 14px;
            line-height: 1.5;
          }
          .loading-spinner {
            border: 4px solid var(--vscode-editor-foreground);
            border-top: 4px solid var(--vscode-button-background);
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 20px auto;
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="welcome-container">
          <div class="logo">🦉</div>
          <div class="title">Welcome to CodeOwl AI</div>
          <div class="subtitle">Your AI-powered code reviewer</div>
          
          <div class="section" id="git-section">
            <div class="section-title">🔧 Git Repository Status</div>
            <div id="git-info"><div class="git-info">Click "Refresh Git Info" to see repository status</div></div>
          </div>

          <div id="commit-analysis" class="section commit-analysis">
            <div class="section-title">🎉 Latest Commit Analysis</div>
            <div id="commit-details"></div>
            <!-- *** MODIFIED *** Renamed button and its function -->
            <button class="button" onclick="startCodeReview()">Start Code Review</button>
          </div>
          
          <!-- *** NEW *** Section for the AI's code review results -->
          <div id="code-review" class="section" style="display: none;">
             <div class="section-title">🤖 AI Code Review</div>
             <div id="review-content"></div>
          </div>
          
          <div style="margin-top: 30px;">
            <button class="button" onclick="refreshGitInfo()">Refresh Git Info</button>
            <button class="button" onclick="debugGit()">Debug Git</button>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          // *** NEW *** Store the latest analysis data to be used by the review button
          let currentAnalysisData = null;
          
          // *** MODIFIED *** Renamed function for clarity
          function startCodeReview() {
            if (currentAnalysisData) {
              vscode.postMessage({
                command: 'startCodeReview',
                analysis: currentAnalysisData
              });
            } else {
              alert("No commit analysis data found. Please wait for a new commit to be detected.");
            }
          }

          function refreshGitInfo() {
            vscode.postMessage({ command: 'getGitInfo' });
          }

          function debugGit() {
            vscode.postMessage({ command: 'debugGit' });
          }

          // Listen for messages from the extension
          window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
              case 'updateGitInfo':
                updateGitDisplay(message.gitInfo);
                break;
              case 'showCommitAnalysis':
                // *** MODIFIED *** Store data and show the analysis
                currentAnalysisData = message.analysis;
                showCommitAnalysis(message.analysis);
                break;
              case 'showCodeReview':
                // *** NEW *** Handle showing the code review from the LLM
                showCodeReview(message);
                break;
            }
          });
          
          // *** NEW *** Function to display the code review results
          function showCodeReview(message) {
            const reviewSection = document.getElementById('code-review');
            const reviewContent = document.getElementById('review-content');
            if (!reviewSection || !reviewContent) return;
            
            reviewSection.style.display = 'block';

            if (message.status === 'loading') {
                reviewContent.innerHTML = '<div><div class="loading-spinner"></div><p style="text-align: center;">CodeOwl is analyzing your commit...</p></div>';
            } else if (message.status === 'complete' && message.review) {
                const review = message.review;
                let html = \`<p style="font-style: italic;">\${review.summary}</p>\`;

                if (review.suggestions.length > 0) {
                    review.suggestions.forEach(s => {
                        html += \`
                          <div class="review-suggestion">
                            <div class="review-file-info">📄 \${s.filePath} (Line: \${s.lineNumber})</div>
                            <div class="review-text">\${s.suggestion}</div>
                          </div>
                        \`;
                    });
                } else {
                    html += '<p>No specific suggestions. Looks good to me! 👍</p>';
                }
                reviewContent.innerHTML = html;
            }
            reviewSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }

          function showCommitAnalysis(analysis) {
            const commitSection = document.getElementById('commit-analysis');
            const commitDetails = document.getElementById('commit-details');
            if (!commitSection || !commitDetails) return;
            
            // Clear any old review
            document.getElementById('code-review').style.display = 'none';
            document.getElementById('review-content').innerHTML = '';

            commitSection.style.display = 'block';
            
            let html = \`<div class="commit-summary">
                          <div>
                            <strong>📍 Commit:</strong> \${analysis.previousCommit} → \${analysis.newCommit}<br>
                            <strong>🕒 Time:</strong> \${new Date(analysis.timestamp).toLocaleTimeString()}<br>
                            <strong>📁 Files Changed:</strong> \${analysis.diffs.length}
                          </div>
                        </div>\`;
            
            analysis.diffs.forEach(diff => {
              html += \`<div class="diff-file">
                         <div class="diff-header">
                           <span>📄 \${diff.filePath.split('/').pop()}</span>
                           <span class="diff-stats">+\${diff.addedLines} -\${diff.removedLines} (\${diff.status})</span>
                         </div>\`;
              
              diff.hunks.slice(0, 2).forEach(hunk => {
                html += '<div class="diff-hunk">';
                hunk.lines.slice(0, 8).forEach(line => {
                  html += \`<div class="diff-line diff-\${line.type}">\${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '} \${line.content}</div>\`;
                });
                if (hunk.lines.length > 8) html += \`<div class="diff-line diff-context">... (\${hunk.lines.length - 8} more lines)</div>\`;
                html += '</div>';
              });
              if (diff.hunks.length > 2) html += \`<div class="diff-line diff-context" style="padding: 8px; text-align: center;">... (\${diff.hunks.length - 2} more hunks)</div>\`;
              html += \`</div>\`;
            });
            commitDetails.innerHTML = html;
            commitSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }

          function updateGitDisplay(gitInfo) {
            // (This function remains largely unchanged)
            const gitInfoElement = document.getElementById('git-info');
            if (gitInfo.status) {
              let html = '<div class="git-info"><strong>Status:</strong> ' + gitInfo.status + '</div>';
              if (gitInfo.debug) {
                html += '<div class="git-info"><strong>Debug Info:</strong></div>';
                html += '<div class="git-info">• Git Extension: ' + (gitInfo.debug.gitExtensionAvailable ? '✅' : '❌') + '</div>';
                html += '<div class="git-info">• Git API: ' + (gitInfo.debug.gitApiAvailable ? '✅' : '❌') + '</div>';
                html += '<div class="git-info">• Repository Count: ' + gitInfo.debug.repositoryCount + '</div>';
                html += '<div class="git-info">• Workspace Folders: ' + gitInfo.debug.workspaceFolders + '</div>';
              }
              if (gitInfo.suggestion) {
                html += '<div class="git-info" style="color: var(--vscode-textLink-foreground); margin-top: 10px;"><strong>💡 Suggestion:</strong><br>' + gitInfo.suggestion + '</div>';
              }
              if (gitInfo.repositoryPath) {
                html += '<div class="git-info"><strong>Repository Path:</strong> ' + gitInfo.repositoryPath + '</div>';
              }
              gitInfoElement.innerHTML = html;
              return;
            }
            let html = '<div class="git-info"><strong>Branch:</strong> ' + gitInfo.branch + '</div>';
            html += '<div class="git-info"><strong>Latest Commit:</strong> ' + gitInfo.commit.substring(0, 8) + '</div>';
            html += '<div class="git-info"><strong>Changed Files:</strong> ' + gitInfo.changedFiles + '</div>';
            gitInfoElement.innerHTML = html;
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

  // Register the sidebar provider
  const provider = new CodeOwlSidebarProvider(context.extensionUri, gitIntegration);
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
}

// This method is called when your extension is deactivated
export function deactivate() {}
