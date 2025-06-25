import { GoogleGenerativeAI } from '@google/generative-ai';
import * as vscode from 'vscode';

interface LLMResponse {
    success: boolean;
    message: string;
    codeChange?: string;
    shouldRemove?: boolean;
}

interface ConversationContext {
    originalSuggestion: string;
    filePath: string;
    codeContext: string;
    conversationHistory: Array<{author: string, message: string, timestamp: Date}>;
}

export class LLMService {
    private genAI: GoogleGenerativeAI | null = null;

    constructor() {
        this.initializeAPI();
    }

    private initializeAPI(): void {
        const config = vscode.workspace.getConfiguration('codeowl');
        const apiKey = config.get<string>('geminiApiKey');
        
        if (apiKey) {
            this.genAI = new GoogleGenerativeAI(apiKey);
        }
    }

    /**
     * Generate a comprehensive fix for the given code issue
     */
    async generateComprehensiveFix(context: ConversationContext): Promise<LLMResponse> {
        if (!this.genAI) {
            return {
                success: false,
                message: '❌ Please configure your Gemini API key in settings'
            };
        }

        try {
            const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `You are CodeOwl AI. Provide a concise fix for this code issue.

**Issue:** ${context.originalSuggestion}
**File:** ${context.filePath}
**Code Context:**
\`\`\`
${context.codeContext}
\`\`\`

**Instructions:**
Provide ONLY:
1. Brief explanation (1-2 sentences)
2. Exact code change needed
3. Specific line numbers where changes should be made

**Response Format:**
Brief explanation of what needs to change.

**Lines to change:** [specific line numbers]

\`\`\`suggestion
[exact code replacement here]
\`\`\`

**Keep it short and focused - no lengthy explanations.**`;

            const result = await model.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            // Extract code change if present
            const codeChangeMatch = text.match(/```suggestion\n([\s\S]*?)\n```/);
            const codeChange = codeChangeMatch ? codeChangeMatch[1] : undefined;

            return {
                success: true,
                message: text,
                codeChange
            };

        } catch (error) {
            console.error('LLM Error:', error);
            return {
                success: false,
                message: '❌ Error generating comprehensive fix. Please try again.'
            };
        }
    }

    /**
     * Handle conversation replies from users
     */
    async handleConversationReply(userMessage: string, context: ConversationContext): Promise<LLMResponse> {
        if (!this.genAI) {
            return {
                success: false,
                message: '❌ Please configure your Gemini API key in settings'
            };
        }

        try {
            const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `You are CodeOwl AI, engaging in a conversation about a code review suggestion.

**Original Suggestion:**
${context.originalSuggestion}

**File:** ${context.filePath}

**Conversation History:**
${context.conversationHistory.map(msg => `${msg.author}: ${msg.message}`).join('\n')}

**User's Latest Message:**
${userMessage}

**Instructions:**
1. Respond naturally and helpfully to the user's message
2. Stay focused on the code review topic
3. If the user seems satisfied or says the issue is resolved, indicate this should be marked as resolved
4. Be concise but informative

**Response Guidelines:**
- If user indicates they've fixed it, understood it, or it's intentional → suggest marking as resolved
- If user asks questions → provide helpful explanations
- If user disagrees → engage constructively and ask for clarification
- Keep responses conversational and helpful

**Response Format:**
Just provide your response message. If the conversation should end (user is satisfied), start your response with "RESOLVE:" to indicate the comment should be auto-collapsed.`;

            const result = await model.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            const shouldRemove = text.startsWith('RESOLVE:');
            const message = shouldRemove ? text.replace('RESOLVE:', '').trim() : text;

            return {
                success: true,
                message,
                shouldRemove
            };

        } catch (error) {
            console.error('LLM Error:', error);
            return {
                success: false,
                message: '❌ Error processing your message. Please try again.'
            };
        }
    }

    /**
     * Refresh API key from settings
     */
    refreshAPIKey(): void {
        this.initializeAPI();
    }
} 