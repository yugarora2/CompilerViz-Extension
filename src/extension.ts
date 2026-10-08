import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Protocol: the compiler prints lines like
//   @VIZ:NODE|<ptr>|<label>|<line>
//   @VIZ:EDGE|<parentPtr>|<childPtr>|<role>
//   @VIZ:TAC|<idx>|<op>|<arg1>|<arg2>|<result>
// media/webview.js expects these as objects (see replay() in that file).
// ---------------------------------------------------------------------------

export type VizEvent =
    | { type: 'NODE'; id: string; label: string; line: number }
    | { type: 'EDGE'; parent: string; child: string; label: string }
    | { type: 'TAC'; idx: number; op: string; a1: string; a2: string; res: string };

export function parseViz(raw: string): VizEvent | null {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('@VIZ:')) { return null; }
    const f = line.slice(5).split('|');
    const kind = f.shift();

    if (kind === 'NODE' && f.length >= 3) {
        return { type: 'NODE', id: f[0], label: f.slice(1, -1).join('|'), line: Number(f[f.length - 1]) || 0 };
    }
    if (kind === 'EDGE' && f.length >= 3) {
        return { type: 'EDGE', parent: f[0], child: f[1], label: f.slice(2).join('|') };
    }
    if (kind === 'TAC' && f.length >= 5) {
        // a '|' inside a string literal adds extra fields; fold them into arg1
        return {
            type: 'TAC',
            idx: Number(f[0]),
            op: f[1],
            a1: f.slice(2, f.length - 2).join('|'),
            a2: f[f.length - 2],
            res: f[f.length - 1],
        };
    }
    return null;
}

function buildCommand(template: string, file: string, workspaceFolder: string): string {
    const quoted = '"' + file.replace(/"/g, '\\"') + '"';
    return template.split('${file}').join(quoted).split('${workspaceFolder}').join(workspaceFolder);
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
    // No inline scripts/styles, so the CSP only needs to allow the extension's own files.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CompilerViz</title>
</head>
<body>
<div id="bar">
  <button id="back" title="Step back">&#9664;&#9664;</button>
  <button id="play" title="Play / pause"></button>
  <button id="fwd" title="Step forward">&#9654;&#9654;</button>
  <input id="slider" type="range" min="0" max="0" value="0">
  <span id="count">0 / 0</span>
  <label>Speed <input id="speed" type="range" min="1" max="10" value="5"></label>
  <span id="status">idle</span>
</div>
<div id="main">
  <div id="treeWrap"><h3>AST</h3><svg id="tree" xmlns="http://www.w3.org/2000/svg"></svg></div>
  <div id="tacWrap">
    <h3>Three-address code</h3>
    <table id="tac">
      <thead><tr><th>#</th><th>op</th><th>arg1</th><th>arg2</th><th>result</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>
<script src="${js}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
    const out = vscode.window.createOutputChannel('CompilerViz');
    const highlight = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    });

    let panel: vscode.WebviewPanel | undefined;
    let ready = false;                       // webview script has loaded and can receive messages
    let pending: (() => void) | undefined;   // run to start once the webview says "ready"
    let child: ChildProcess | undefined;
    let runId = 0;
    let sourceUri: vscode.Uri | undefined;

    const post = (msg: unknown) => { void panel?.webview.postMessage(msg); };

    async function revealLine(line: number) {
        if (!sourceUri || !(line > 0)) { return; }
        const uri = sourceUri;
        const doc = await vscode.workspace.openTextDocument(uri);
        const existing = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One,
            preserveFocus: true,
            preview: false,
        });
        const l = Math.min(line, doc.lineCount) - 1;
        const range = new vscode.Range(l, 0, l, 0);
        editor.setDecorations(highlight, [range]);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    function ensurePanel(): vscode.WebviewPanel {
        if (panel) {
            panel.reveal(undefined, true);
            return panel;
        }
        ready = false;
        panel = vscode.window.createWebviewPanel(
            'compilerViz',
            'CompilerViz',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            }
        );
        panel.webview.html = getHtml(panel.webview, context.extensionUri);
        panel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'ready') {
                ready = true;
                const go = pending;
                pending = undefined;
                go?.();
            } else if (msg.command === 'reveal') {
                void revealLine(Number(msg.line));
            }
        });
        panel.onDidDispose(() => {
            child?.kill();
            child = undefined;
            panel = undefined;
            ready = false;
            pending = undefined;
            for (const e of vscode.window.visibleTextEditors) { e.setDecorations(highlight, []); }
        });
        return panel;
    }

    function startRun(command: string, cwd: string) {
        child?.kill();
        const myRun = ++runId;
        let buf = '';
        let events = 0;

        out.clear();
        out.appendLine(`$ ${command}`);
        out.appendLine(`(cwd: ${cwd})`);
        post({ command: 'reset' });

        const handleLine = (line: string) => {
            const ev = parseViz(line);
            if (ev) {
                events++;
                post({ command: 'event', ev });
            } else if (line.trim()) {
                out.appendLine(line);   // normal compiler output goes to the Output channel
            }
        };

        const p = spawn(command, { shell: true, cwd });
        child = p;

        p.stdout.on('data', (d: Buffer) => {
            if (myRun !== runId) { return; }
            buf += d.toString();
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {   // a chunk can end mid-line, so buffer by newline
                handleLine(buf.slice(0, i));
                buf = buf.slice(i + 1);
            }
        });
        p.stderr.on('data', (d: Buffer) => {
            if (myRun === runId) { out.append(d.toString()); }
        });
        p.on('error', err => {
            if (myRun !== runId) { return; }
            out.appendLine(`Failed to start: ${err.message}`);
            out.show(true);
            post({ command: 'done', code: -1 });
        });
        p.on('close', code => {
            if (myRun !== runId) { return; }
            if (buf) { handleLine(buf); buf = ''; }
            child = undefined;
            out.appendLine(`\n[exit ${code}, ${events} @VIZ events]`);
            // Non-zero exit is normal for programs with errors: still show what we got.
            if (code !== 0) { out.show(true); }
            post({ command: 'done', code });
        });
    }

    const cmd = vscode.commands.registerCommand('compilerviz.run', async () => {
        // The webview steals focus, so fall back to the last source file we used.
        let doc = vscode.window.activeTextEditor?.document;
        if ((!doc || doc.isUntitled) && sourceUri) {
            doc = await vscode.workspace.openTextDocument(sourceUri);
        }
        if (!doc || doc.isUntitled) {
            vscode.window.showErrorMessage('CompilerViz: open your MiniLang source file (.ml) in the editor first, then run the command.');
            return;
        }
        if (doc.isDirty) { await doc.save(); }   // the compiler reads from disk
        sourceUri = doc.uri;
        const file = doc.uri.fsPath;

        const cfg = vscode.workspace.getConfiguration('compilerviz');
        let template = (cfg.get<string>('command', '') || '').trim();
        if (!template) {
            const entered = await vscode.window.showInputBox({
                prompt: 'Command that runs your compiler. Use ${file} for the source file.',
                value: '/absolute/path/to/minilang --no-html ${file}',
                ignoreFocusOut: true,
            });
            if (!entered) { return; }
            template = entered.includes('${file}') ? entered.trim() : entered.trim() + ' ${file}';
            await cfg.update('command', template, vscode.ConfigurationTarget.Global);
        }

        const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(file);
        const command = buildCommand(template, file, folder);

        ensurePanel();
        const go = () => startRun(command, folder);
        if (ready) { go(); } else { pending = go; }
    });

    context.subscriptions.push(out, highlight, cmd, { dispose: () => child?.kill() });
}

export function deactivate() { /* disposables handle cleanup */ }