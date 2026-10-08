import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('compilerviz.run', async () => {
        const compilerPath = await vscode.window.showInputBox({ prompt: "Path to compiler (e.g., ./minilang)" });
        const sourcePath = await vscode.window.showInputBox({ prompt: "Path to source file (e.g., test_valid.ml)" });

        if (!compilerPath || !sourcePath) return;

        // Read the actual source code file
        const sourceCode = fs.readFileSync(sourcePath, 'utf8');

        const panel = vscode.window.createWebviewPanel(
            'compilerViz',
            'Live Compiler Diagnostics',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );
        panel.webview.html = getWebviewContent();

        // Send the source code to the UI first
        panel.webview.postMessage({ command: 'init', source: sourceCode });

        const compilerProcess = spawn(compilerPath, [sourcePath]);
        compilerProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('@VIZ:')) {
                    panel.webview.postMessage({ command: 'animate', text: line });
                }
            }
        });
    });
    context.subscriptions.push(disposable);
}

function getWebviewContent() {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
        <style>
            body { font-family: sans-serif; background-color: #1e1e1e; color: white; padding: 10px; margin: 0; }
            .layout { display: flex; gap: 10px; height: 95vh; }
            .col { flex: 1; display: flex; flex-direction: column; background: #252526; border-radius: 8px; border: 1px solid #444; }
            h3 { margin: 0; padding: 10px; background: #333; border-radius: 8px 8px 0 0; font-size: 14px; text-align: center; }
            
            /* Source Code Viewer CSS */
            #source-view { padding: 10px; overflow-y: auto; flex: 1; }
            .source-line { padding: 3px 5px; font-family: monospace; display: flex; color: #d4d4d4; }
            .line-num { width: 30px; color: #858585; user-select: none; }
            .active-line { background-color: #37373d; border-left: 4px solid #5b8cff; color: #5b8cff; font-weight: bold; }
            
            #mynetwork { flex: 1; background: #171a23; }
            #tac-log { padding: 10px; overflow-y: auto; flex: 1; font-family: monospace; color: #4ec9b0; }
        </style>
    </head>
    <body>
        <div class="layout">
            <div class="col" style="flex: 0.8">
                <h3>Source Code</h3>
                <div id="source-view"></div>
            </div>
            <div class="col" style="flex: 1.5">
                <h3>Live AST</h3>
                <div id="mynetwork"></div>
            </div>
            <div class="col" style="flex: 1.2">
                <h3>TAC Generation</h3>
                <div id="tac-log"></div>
            </div>
        </div>

        <script>
            const nodes = new vis.DataSet([]);
            const edges = new vis.DataSet([]);
            const container = document.getElementById('mynetwork');
            const options = {
                layout: { hierarchical: { direction: 'UD', sortMethod: 'directed', levelSeparation: 60 } },
                physics: false,
                nodes: { color: { background: '#5b8cff', border: '#171a23' }, font: { color: 'white' }, shape: 'box' },
                edges: { color: '#8b90a3', arrows: 'to' }
            };
            const network = new vis.Network(container, { nodes, edges }, options);

            const tacLog = document.getElementById('tac-log');
            
            // The Animation Queue
            let eventQueue = [];
            let isPlaying = false;

            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.command === 'init') {
                    // Render the source code with line numbers
                    const lines = msg.source.split('\\n');
                    let html = '';
                    lines.forEach((line, i) => {
                        // Escape HTML characters
                        const cleanLine = line.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                        html += \`<div id="line-\${i+1}" class="source-line"><span class="line-num">\${i+1}</span>\${cleanLine}</div>\`;
                    });
                    document.getElementById('source-view').innerHTML = html;
                } 
                else if (msg.command === 'animate') {
                    eventQueue.push(msg.text);
                    if (!isPlaying) {
                        isPlaying = true;
                        processQueue(); // Start the animation loop
                    }
                }
            });

            function processQueue() {
                if (eventQueue.length === 0) {
                    isPlaying = false;
                    return;
                }
                const text = eventQueue.shift();
                const parts = text.trim().split('|');

                // Remove the arrow/highlight from all lines
                document.querySelectorAll('.source-line').forEach(el => el.classList.remove('active-line'));

                if (parts[0] === '@VIZ:NODE') {
                    nodes.add({ id: parts[1], label: parts[2] });
                    // If a line number is provided in parts[3], highlight it
                    if (parts[3] && parts[3] !== "0") {
                        const lineEl = document.getElementById('line-' + parts[3]);
                        if (lineEl) {
                            lineEl.classList.add('active-line');
                            lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                } 
                else if (parts[0] === '@VIZ:EDGE') {
                    edges.add({ from: parts[1], to: parts[2], label: parts[3] || '' });
                }
                else if (parts[0] === '@VIZ:TAC') {
                    const tacLine = parts[1] + ": " + parts[2] + " " + parts[3] + " " + parts[4] + " -> " + parts[5];
                    tacLog.innerHTML += tacLine + "<br/>";
                    tacLog.scrollTop = tacLog.scrollHeight;
                }

                // Wait 600 milliseconds before processing the next event to create the animation
                setTimeout(processQueue, 600);
            }
        </script>
    </body>
    </html>`;
}