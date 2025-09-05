import * as vscode from 'vscode';
import axios from 'axios';

// Extension activation
export function activate(context: vscode.ExtensionContext) {
    console.log('Self-Healing Assistant is now active!');

    // Register commands
    const fixCodeDisposable = vscode.commands.registerCommand(
        'selfHealing.fixCode',
        () => fixCode(false)
    );

    const fixSelectionDisposable = vscode.commands.registerCommand(
        'selfHealing.fixSelection',
        () => fixCode(true)
    );

    // Add to subscriptions for cleanup
    context.subscriptions.push(fixCodeDisposable, fixSelectionDisposable);

    // Show welcome message
    vscode.window.showInformationMessage(
        'Self-Healing Assistant activated! Use Ctrl+Shift+F to fix code.'
    );
}

// Main function to fix code
async function fixCode(selectionOnly: boolean = false) {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showErrorMessage('No active editor found. Please open a file first.');
        return;
    }

    const document = editor.document;

    // Check if file is supported
    if (!isSupportedLanguage(document.languageId)) {
        const supportedLangs = getSupportedLanguages().join(', ');
        vscode.window.showWarningMessage(
            `Language "${document.languageId}" is not supported yet. Supported: ${supportedLangs}`
        );
        return;
    }

    // Get code to fix
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;

    let codeToFix: string;
    let rangeToReplace: vscode.Range;

    if (selectionOnly && hasSelection) {
        codeToFix = document.getText(selection);
        rangeToReplace = selection;
    } else if (!selectionOnly) {
        codeToFix = document.getText();
        rangeToReplace = new vscode.Range(0, 0, document.lineCount, 0);
    } else {
        vscode.window.showErrorMessage('No code selected. Select code first or use "Fix Entire File".');
        return;
    }

    if (!codeToFix.trim()) {
        vscode.window.showErrorMessage('Selected code is empty.');
        return;
    }

    // Show progress and fix code
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Self-Healing Assistant",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Analyzing code..." });

            // Get problems/errors for context
            const problems = await getProblemsForFile(document);

            progress.report({ increment: 20, message: "Sending to AI..." });

            // Send to n8n/AI
            const result = await sendCodeToAI({
                code: codeToFix,
                language: document.languageId,
                filename: document.fileName,
                problems: problems
            });

            progress.report({ increment: 70, message: "Processing response..." });

            if (!result.fixedCode) {
                throw new Error('No fixed code received from AI');
            }

            // Apply or preview changes
            progress.report({ increment: 90, message: "Applying changes..." });

            const config = vscode.workspace.getConfiguration('selfHealing');
            const showDiff = config.get<boolean>('showDiffPreview', true);

            if (showDiff) {
                await showDiffAndApply(codeToFix, result.fixedCode, result.explanation, editor, rangeToReplace);
            } else {
                await applyFixedCode(editor, result.fixedCode, rangeToReplace);
                showSuccessMessage(result.explanation);
            }

            progress.report({ increment: 100, message: "Complete!" });
        });

    } catch (error) {
        handleError(error);
    }
}

// Send code to AI service
async function sendCodeToAI(payload: CodeFixPayload): Promise<CodeFixResponse> {
    const config = vscode.workspace.getConfiguration('selfHealing');
    const webhookUrl = config.get<string>('n8nWebhookUrl');
    const timeout = config.get<number>('requestTimeout', 30000);
    const enableLogging = config.get<boolean>('enableLogging', false);

    if (!webhookUrl) {
        throw new Error('n8n webhook URL not configured. Please check your settings.');
    }

    if (enableLogging) {
        console.log('Sending code to AI:', { ...payload, code: `${payload.code.length} chars` });
    }

    try {
        const response = await axios.post<CodeFixResponse>(webhookUrl, payload, {
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'VS Code Self-Healing Assistant'
            }
        });

        if (enableLogging) {
            console.log('AI response received:', response.data);
        }

        return response.data;

    } catch (error: any) { 
        if ((error)) {
            if (error.code === 'ECONNREFUSED') {
                throw new Error(`Cannot connect to n8n at ${webhookUrl}. Is n8n running?`);
            } else if (error.response?.status === 404) {
                throw new Error(`Webhook endpoint not found. Check your n8n workflow.`);
            } else if (error.code === 'ECONNABORTED') {
                throw new Error(`Request timed out after ${timeout}ms. Try increasing the timeout.`);
            }
        }

        throw error;
    }
}

// Show diff preview and apply if accepted
async function showDiffAndApply(
    originalCode: string,
    fixedCode: string,
    explanation: string,
    editor: vscode.TextEditor,
    range: vscode.Range
) {
    const action = await vscode.window.showInformationMessage(
        `AI suggests changes: ${explanation}`,
        { modal: true },
        'Apply Changes',
        'Show Diff',
        'Cancel'
    );

    switch (action) {
        case 'Apply Changes':
            await applyFixedCode(editor, fixedCode, range);
            showSuccessMessage(explanation);
            break;

        case 'Show Diff':
            await showDiffDocument(originalCode, fixedCode, explanation);
            // After showing diff, ask again
            const applyAction = await vscode.window.showInformationMessage(
                'Apply the changes shown in diff?',
                'Apply',
                'Cancel'
            );
            if (applyAction === 'Apply') {
                await applyFixedCode(editor, fixedCode, range);
                showSuccessMessage(explanation);
            }
            break;

        case 'Cancel':
            vscode.window.showInformationMessage('Code fix cancelled.');
            break;
    }
}

// Apply fixed code to editor
async function applyFixedCode(
    editor: vscode.TextEditor,
    fixedCode: string,
    range: vscode.Range
) {
    await editor.edit(editBuilder => {
        editBuilder.replace(range, fixedCode);
    });
}

// Show diff in side-by-side view
async function showDiffDocument(originalCode: string, fixedCode: string, explanation: string) {
    const originalUri = vscode.Uri.parse('untitled:Original Code');
    const fixedUri = vscode.Uri.parse('untitled:Fixed Code');

    // Create temporary documents
    const originalDoc = await vscode.workspace.openTextDocument(originalUri);
    const fixedDoc = await vscode.workspace.openTextDocument(fixedUri);

    // Set content
    const originalEdit = new vscode.WorkspaceEdit();
    originalEdit.insert(originalUri, new vscode.Position(0, 0), originalCode);

    const fixedEdit = new vscode.WorkspaceEdit();
    fixedEdit.insert(fixedUri, new vscode.Position(0, 0), fixedCode);

    await vscode.workspace.applyEdit(originalEdit);
    await vscode.workspace.applyEdit(fixedEdit);

    // Show diff
    await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        fixedUri,
        `AI Code Fixes: ${explanation}`
    );
}

// Get VS Code problems/diagnostics for current file
async function getProblemsForFile(document: vscode.TextDocument): Promise<string[]> {
    const diagnostics = vscode.languages.getDiagnostics(document.uri);

    return diagnostics.map(diagnostic => {
        const line = diagnostic.range.start.line + 1;
        const severity = vscode.DiagnosticSeverity[diagnostic.severity];
        return `Line ${line}: ${diagnostic.message} (${severity})`;
    });
}

// Utility functions
function isSupportedLanguage(languageId: string): boolean {
    return getSupportedLanguages().includes(languageId);
}

function getSupportedLanguages(): string[] {
    return [
        'javascript', 'typescript', 'python', 'java', 'cpp', 'c',
        'go', 'php', 'csharp', 'ruby', 'swift', 'kotlin'
    ];
}

function showSuccessMessage(explanation: string) {
    vscode.window.showInformationMessage(
        `✅ Code fixed successfully! ${explanation}`
    );
}

function handleError(error: any) {
    console.error('Self-Healing Assistant Error:', error);

    let message = 'An error occurred while fixing code.';

    if (error instanceof Error) {
        message = error.message;
    }

    vscode.window.showErrorMessage(`Self-Healing Assistant: ${message}`);
}

// Type definitions
interface CodeFixPayload {
    code: string;
    language: string;
    filename: string;
    problems: string[];
}

interface CodeFixResponse {
    fixedCode: string;
    explanation: string;
    confidence?: number;
}

// Extension deactivation
export function deactivate() {
    console.log('Self-Healing Assistant deactivated');
}