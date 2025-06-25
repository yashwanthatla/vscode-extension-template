import * as vscode from 'vscode';
import { LLMService } from './llmService';

// Define the interfaces your CommentManager will use.
// It's good practice to have these in a shared types file,
// but for a self-contained example, we'll place them here.
interface CodeReviewSuggestion {
  filePath: string;
  startLine: number;
  endLine: number;
  suggestion: string;
  codeChange?: string; // Exact code replacement if possible
}

interface CodeReview {
  summary: string;
  suggestions: CodeReviewSuggestion[];
}

// Interface for conversation history in comments
interface ConversationMessage {
  author: string;
  message: string;
  timestamp: Date;
}

interface CommentThreadData {
  suggestion: CodeReviewSuggestion;
  conversation: ConversationMessage[];
  isCollapsed: boolean;
}

/**
 * Manages advanced AI-generated code review comments with interactive features
 */
export class CommentManager implements vscode.Disposable {
    private commentController: vscode.CommentController;
    private threads: Map<string, vscode.CommentThread> = new Map();
    private threadData: Map<string, CommentThreadData> = new Map();
    private extensionUri: vscode.Uri;
    private llmService: LLMService;

    /**
     * Initializes the CommentManager and creates the controller.
     * @param extensionUri The URI of the extension, needed for resolving icon paths.
     */
    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        this.llmService = new LLMService();

        // The controller is the top-level entry point for all commenting features.
        this.commentController = vscode.comments.createCommentController(
            'codeowl.aiReview',
            'CodeOwl AI Review'
        );
        
        // Set options for the controller - disabled since replies are not supported
        // this.commentController.options = {
        //     placeHolder: 'Reply to CodeOwl AI... (Press Enter to send)',
        //     prompt: 'Have questions? Ask CodeOwl AI!'
        // };

        // Enable comment thread creation and replies
        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: () => {
                return [];
            }
        };

        // Handle comment actions (apply, reply, etc.)
        this.setupCommentHandlers();
        
        console.log('Advanced CommentManager initialized.');
    }

    private setupCommentHandlers(): void {
        // Register commands for comment actions - these work on thread context
        vscode.commands.registerCommand('codeowl.applySuggestion', async (thread?: vscode.CommentThread) => {
            if (thread) {
                const threadId = this.findThreadIdByThread(thread);
                if (threadId) {
                    await this.applySuggestion(threadId);
                }
            }
        });

        vscode.commands.registerCommand('codeowl.fixWithAI', async (thread?: vscode.CommentThread) => {
            if (thread) {
                const threadId = this.findThreadIdByThread(thread);
                if (threadId) {
                    await this.fixWithAI(threadId);
                }
            }
        });

        vscode.commands.registerCommand('codeowl.markUnderstood', async (thread?: vscode.CommentThread) => {
            if (thread) {
                const threadId = this.findThreadIdByThread(thread);
                if (threadId) {
                    await this.markAsUnderstood(threadId);
                }
            }
        });

        // Handle replies to comments (disabled for now)
        // vscode.commands.registerCommand('codeowl.addComment', async (reply: vscode.CommentReply) => {
        //     await this.handleUserReply(reply);
        // });
    }

    private async handleUserReply(reply: vscode.CommentReply): Promise<void> {
        const threadId = this.findThreadId(reply.thread);
        if (!threadId) return;

        const threadData = this.threadData.get(threadId);
        if (!threadData) return;

        // Add user message to conversation
        threadData.conversation.push({
            author: 'User',
            message: reply.text,
            timestamp: new Date()
        });

        // Add user comment to thread
        const userComment: vscode.Comment = {
            author: { name: '👤 User' },
            body: new vscode.MarkdownString(reply.text),
            mode: vscode.CommentMode.Preview
        };

        reply.thread.comments = [...reply.thread.comments, userComment];

        // Show loading comment
        const loadingComment: vscode.Comment = {
            author: {
                name: 'CodeOwl AI',
                iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
            },
            body: new vscode.MarkdownString('🤔 *Analyzing your response...*'),
            mode: vscode.CommentMode.Preview
        };

        reply.thread.comments = [...reply.thread.comments, loadingComment];

        try {
            // Send to AI for response
            const aiResponse = await this.getAIConversationResponse(threadData, reply.text);
            
            // Remove loading comment
            reply.thread.comments = reply.thread.comments.slice(0, -1);
            
            if (aiResponse.shouldRemove) {
                // AI is satisfied, mark as resolved
                const finalComment: vscode.Comment = {
                    author: {
                        name: 'CodeOwl AI',
                        iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                    },
                    body: new vscode.MarkdownString(`✅ ${aiResponse.message}`),
                    mode: vscode.CommentMode.Preview
                };
                
                reply.thread.comments = [...reply.thread.comments, finalComment];
                
                // Auto-collapse after 2 seconds
                setTimeout(() => {
                    this.markAsUnderstood(threadId);
                }, 2000);
            } else {
                // Continue conversation
                threadData.conversation.push({
                    author: 'CodeOwl AI',
                    message: aiResponse.message,
                    timestamp: new Date()
                });

                const responseComment: vscode.Comment = {
                    author: {
                        name: 'CodeOwl AI',
                        iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                    },
                    body: new vscode.MarkdownString(aiResponse.message),
                    mode: vscode.CommentMode.Preview
                };

                reply.thread.comments = [...reply.thread.comments, responseComment];
            }
        } catch (error) {
            console.error('Error getting AI response:', error);
            reply.thread.comments = reply.thread.comments.slice(0, -1);
            
            const errorComment: vscode.Comment = {
                author: {
                    name: 'CodeOwl AI',
                    iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                },
                body: new vscode.MarkdownString('❌ *Sorry, I encountered an error processing your response.*'),
                mode: vscode.CommentMode.Preview
            };
            
            reply.thread.comments = [...reply.thread.comments, errorComment];
        }
    }

    private async handleUserReplyFromComment(threadId: string, replyText: string): Promise<void> {
        const threadData = this.threadData.get(threadId);
        const thread = this.threads.get(threadId);
        
        if (!threadData || !thread) return;

        // Add user message to conversation
        threadData.conversation.push({
            author: 'User',
            message: replyText,
            timestamp: new Date()
        });

        // Show loading comment
        const loadingComment: vscode.Comment = {
            author: {
                name: 'CodeOwl AI',
                iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
            },
            body: new vscode.MarkdownString('🤔 *Analyzing your response...*'),
            mode: vscode.CommentMode.Preview
        };

        thread.comments = [...thread.comments, loadingComment];

        try {
            // Send to AI for response
            const aiResponse = await this.getAIConversationResponse(threadData, replyText);
            
            // Remove loading comment
            thread.comments = thread.comments.slice(0, -1);
            
            if (aiResponse.shouldRemove) {
                // Auto-collapse
                setTimeout(() => {
                    this.markAsUnderstood(threadId);
                }, 2000);
            } else {
                // Continue conversation
                threadData.conversation.push({
                    author: 'CodeOwl AI',
                    message: aiResponse.message,
                    timestamp: new Date()
                });

                const responseComment: vscode.Comment = {
                    author: {
                        name: 'CodeOwl AI',
                        iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                    },
                    body: new vscode.MarkdownString(aiResponse.message),
                    mode: vscode.CommentMode.Preview
                };

                thread.comments = [...thread.comments, responseComment];
            }
        } catch (error) {
            console.error('Error getting AI response:', error);
            thread.comments = thread.comments.slice(0, -1);
        }
    }

    private async getAIConversationResponse(threadData: CommentThreadData, userMessage: string): Promise<{message: string, shouldRemove: boolean}> {
        try {
            const context = {
                originalSuggestion: threadData.suggestion.suggestion,
                filePath: threadData.suggestion.filePath,
                codeContext: '', // You can add code context here
                conversationHistory: threadData.conversation
            };

            const response = await this.llmService.handleConversationReply(userMessage, context);
            
            if (response.success) {
                return {
                    message: response.message,
                    shouldRemove: response.shouldRemove || false
                };
            } else {
                return {
                    message: response.message,
                    shouldRemove: false
                };
            }
        } catch (error) {
            console.error('Error getting AI response:', error);
            return {
                message: '❌ Error processing your message. Please try again.',
                shouldRemove: false
            };
        }
    }

    /**
     * Takes a code review object from the AI and displays its suggestions as
     * native VS Code comments in the corresponding files.
     * @param review The CodeReview object generated by the LLM.
     */
    public async displayReviewsAsComments(review: CodeReview): Promise<void> {
        // Clear any old comments first to prevent clutter from previous reviews.
        this.clearAllComments();

        if (!review.suggestions || review.suggestions.length === 0) {
            vscode.window.showInformationMessage('CodeOwl AI: No suggestions found. Looks good!');
            return;
        }

        for (const suggestion of review.suggestions) {
            await this.createAdvancedCommentThread(suggestion);
        }

        vscode.window.showInformationMessage(`CodeOwl AI: Added ${review.suggestions.length} review comment(s) with interactive features.`);
    }

    private async createAdvancedCommentThread(suggestion: CodeReviewSuggestion): Promise<void> {
            const fileUris = await vscode.workspace.findFiles(`**/${suggestion.filePath}`, '**/node_modules/**', 1);

            if (fileUris.length === 0) {
            console.warn(`[CodeOwl] Could not find file: ${suggestion.filePath}`);
            return;
            }

            const fileUri = fileUris[0];
            const startLine = Math.max(0, suggestion.startLine - 1);
            const endLine = Math.max(0, suggestion.endLine - 1);
        const range = new vscode.Range(startLine, 0, endLine, 1024);

        // Generate unique thread ID
        const threadId = `codeowl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create initial comment with enhanced UI
        const comment = this.createEnhancedComment(suggestion, threadId);

        const thread = this.commentController.createCommentThread(
            fileUri,
            range,
            [comment]
        );

        // Configure thread properties
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.canReply = false;
        thread.label = 'CodeOwl AI Review';
        thread.contextValue = suggestion.codeChange ? 'codeowl-comment-with-change' : 'codeowl-comment-suggestion';

        // Store thread data
        this.threads.set(threadId, thread);
        this.threadData.set(threadId, {
            suggestion,
            conversation: [{
                author: 'CodeOwl AI',
                message: suggestion.suggestion,
                timestamp: new Date()
            }],
            isCollapsed: false
        });
    }

    private createEnhancedComment(suggestion: CodeReviewSuggestion, threadId: string): vscode.Comment {
        // Create colorful, well-formatted comment body
        let body = `💡 **Issue:** ${suggestion.suggestion}\n\n`;
        
        if (suggestion.codeChange) {
            // Detect language from file extension
            const fileExtension = suggestion.filePath.split('.').pop()?.toLowerCase() || '';
            const languageMap: { [key: string]: string } = {
                'ts': 'typescript',
                'js': 'javascript',
                'tsx': 'tsx',
                'jsx': 'jsx',
                'py': 'python',
                'java': 'java',
                'cpp': 'cpp',
                'c': 'c',
                'cs': 'csharp',
                'php': 'php',
                'rb': 'ruby',
                'go': 'go',
                'rs': 'rust',
                'swift': 'swift',
                'kt': 'kotlin',
                'scala': 'scala',
                'html': 'html',
                'css': 'css',
                'scss': 'scss',
                'less': 'less',
                'json': 'json',
                'xml': 'xml',
                'yaml': 'yaml',
                'yml': 'yaml',
                'sql': 'sql',
                'sh': 'bash',
                'bash': 'bash',
                'zsh': 'zsh',
                'ps1': 'powershell',
                'md': 'markdown',
                'vue': 'vue',
                'svelte': 'svelte'
            };
            
            const language = languageMap[fileExtension] || 'text';
            
            body += `✨ **Suggested Code Change:**\n\`\`\`${language}\n${suggestion.codeChange}\n\`\`\`\n\n`;
            body += `🎯 **Action:** Click the **Apply** button above to automatically implement this change!`;
        } else {
            body += `📝 **Recommendation:** This is a general suggestion for improvement. Please review and implement manually.\n\n`;
            body += `🤔 **Need Help?** Click **Fix with AI** above for a more detailed solution!`;
        }

            const comment: vscode.Comment = {
                author: {
                name: 'CodeOwl AI',
                    iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                },
            body: new vscode.MarkdownString(body),
            mode: vscode.CommentMode.Preview,
            contextValue: suggestion.codeChange ? 'codeowl-comment-with-change' : 'codeowl-comment-suggestion'
        };

        return comment;
    }

    private async applySuggestion(threadId: string): Promise<void> {
        const threadData = this.threadData.get(threadId);
        const thread = this.threads.get(threadId);
        
        if (!threadData || !thread || !threadData.suggestion.codeChange || !thread.range) {
            vscode.window.showErrorMessage('No code change available to apply.');
            return;
        }

        try {
            const edit = new vscode.WorkspaceEdit();
            
            edit.replace(
                thread.uri,
                thread.range,
                threadData.suggestion.codeChange
            );

            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                vscode.window.showInformationMessage('✅ Code suggestion applied successfully!');
                // Delete the comment completely
                thread.dispose();
                this.threads.delete(threadId);
                this.threadData.delete(threadId);
            } else {
                vscode.window.showErrorMessage('❌ Failed to apply code suggestion.');
            }
        } catch (error) {
            console.error('Error applying suggestion:', error);
            vscode.window.showErrorMessage('❌ Error applying code suggestion.');
        }
    }

    private async markAsUnderstood(threadId: string): Promise<void> {
        const thread = this.threads.get(threadId);
        
        if (thread) {
            // Delete the comment completely
            thread.dispose();
            this.threads.delete(threadId);
            this.threadData.delete(threadId);
            vscode.window.showInformationMessage('💡 Suggestion marked as understood');
        }
    }

    private findThreadId(thread: vscode.CommentThread): string | undefined {
        for (const [id, storedThread] of this.threads.entries()) {
            if (storedThread === thread) {
                return id;
            }
        }
        return undefined;
    }

    /**
     * Removes all AI-generated review comments from all files in the editor.
     */
    public clearAllComments(): void {
        console.log(`[CodeOwl] Clearing ${this.threads.size} AI review comment threads...`);
        this.threads.forEach(thread => thread.dispose());
        this.threads.clear();
        this.threadData.clear();
    }

    private async fixWithAI(threadId: string): Promise<void> {
        const threadData = this.threadData.get(threadId);
        const thread = this.threads.get(threadId);
        
        if (!threadData || !thread) {
            vscode.window.showErrorMessage('Unable to process AI fix request.');
            return;
        }

        try {
            vscode.window.showInformationMessage('🤖 CodeOwl is generating a comprehensive fix...');
            
            // Show loading comment
            const loadingComment: vscode.Comment = {
                author: {
                    name: 'CodeOwl AI',
                    iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                },
                body: new vscode.MarkdownString('🔧 *Generating comprehensive fix...*'),
                mode: vscode.CommentMode.Preview
            };

            thread.comments = [...thread.comments, loadingComment];
            
            // Read the actual file content for context
            let codeContext = '';
            try {
                const document = await vscode.workspace.openTextDocument(thread.uri);
                const startLine = Math.max(0, threadData.suggestion.startLine - 5); // 5 lines before
                const endLine = Math.min(document.lineCount - 1, threadData.suggestion.endLine + 5); // 5 lines after
                
                let contextLines: string[] = [];
                for (let i = startLine; i <= endLine; i++) {
                    const lineNumber = i + 1; // 1-indexed for display
                    const lineText = document.lineAt(i).text;
                    contextLines.push(`${lineNumber}: ${lineText}`);
                }
                codeContext = contextLines.join('\n');
            } catch (error) {
                console.error('Error reading file context:', error);
                codeContext = 'Unable to read file context';
            }
            
            // Get AI fix
            const context = {
                originalSuggestion: threadData.suggestion.suggestion,
                filePath: threadData.suggestion.filePath,
                codeContext: codeContext,
                conversationHistory: threadData.conversation
            };

            const response = await this.llmService.generateComprehensiveFix(context);
            
            // Remove loading comment
            thread.comments = thread.comments.slice(0, -1);
            
            if (response.success) {
                // Detect language from file extension for proper formatting
                const fileExtension = threadData.suggestion.filePath.split('.').pop()?.toLowerCase() || '';
                const languageMap: { [key: string]: string } = {
                    'ts': 'typescript', 'js': 'javascript', 'tsx': 'tsx', 'jsx': 'jsx',
                    'py': 'python', 'java': 'java', 'cpp': 'cpp', 'c': 'c',
                    'cs': 'csharp', 'php': 'php', 'rb': 'ruby', 'go': 'go',
                    'rs': 'rust', 'swift': 'swift', 'kt': 'kotlin', 'scala': 'scala',
                    'html': 'html', 'css': 'css', 'scss': 'scss', 'json': 'json',
                    'xml': 'xml', 'yaml': 'yaml', 'yml': 'yaml', 'sql': 'sql',
                    'sh': 'bash', 'bash': 'bash', 'md': 'markdown'
                };
                const language = languageMap[fileExtension] || 'text';
                
                // Format the AI response with colors and proper code blocks
                let formattedMessage = response.message;
                
                // Replace ```suggestion blocks with proper language blocks
                formattedMessage = formattedMessage.replace(
                    /```suggestion\n([\s\S]*?)\n```/g,
                    `\`\`\`${language}\n$1\n\`\`\``
                );
                
                // Add colorful formatting
                formattedMessage = `🤖 **AI-Generated Comprehensive Fix**\n\n${formattedMessage}`;
                
                const fixComment: vscode.Comment = {
                    author: {
                        name: '🤖 CodeOwl AI',
                        iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                    },
                    body: new vscode.MarkdownString(formattedMessage),
                    mode: vscode.CommentMode.Preview
                };

                thread.comments = [...thread.comments, fixComment];
                
                // If there's a code change, add it to the suggestion
                if (response.codeChange) {
                    threadData.suggestion.codeChange = response.codeChange;
                }
            } else {
                const errorComment: vscode.Comment = {
                    author: {
                        name: '❌ CodeOwl AI',
                        iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'owl-icon.svg')
                    },
                    body: new vscode.MarkdownString(`🚨 **Error:** ${response.message}`),
                    mode: vscode.CommentMode.Preview
                };

                thread.comments = [...thread.comments, errorComment];
            }
            
        } catch (error) {
            console.error('Error generating AI fix:', error);
            vscode.window.showErrorMessage('❌ Error generating AI fix.');
        }
    }

    private findThreadIdByThread(thread: vscode.CommentThread): string | undefined {
        for (const [id, storedThread] of this.threads.entries()) {
            if (storedThread === thread) {
                return id;
            }
        }
        return undefined;
    }

    /**
     * Cleans up all resources used by the manager. Called when the extension is deactivated.
     */
    public dispose(): void {
        this.clearAllComments();
        this.commentController.dispose();
    }
}