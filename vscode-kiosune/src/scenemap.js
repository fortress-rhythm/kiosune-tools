'use strict';

const vscode = require('vscode');
const { layoutGraph } = require('./graph');
const { renderSceneMap } = require('./svg');
const { blockAt } = require('./parser');

function nonce() {
  return Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
}

function html(webview, extensionUri) {
  const asset = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
  const key = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${key}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('media', 'scenemap.css')}">
<title>Scene map</title>
</head>
<body>
<header>
  <span class="grow"><input type="search" id="search" placeholder="Filter blocks and backgrounds"></span>
  <label class="toggle"><input type="checkbox" id="toggle-fall" checked> fall-through</label>
  <label class="toggle"><input type="checkbox" id="toggle-hub" checked> hub returns</label>
  <label class="toggle" title="Show who is on stage where each block starts; orange = it depends on the route in"><input type="checkbox" id="toggle-stage"> stage</label>
  <button id="fit" title="Fit the whole map (0)">Fit</button>
  <button id="export" title="Save the map as an SVG file next to the script">Export SVG</button>
</header>
<div id="stage"><div id="empty">Open a Kiosune script to draw its scene map.</div></div>
<footer>
  <span class="key"><span class="swatch"></span> jump or option</span>
  <span class="key"><span class="swatch conditional"></span> conditional</span>
  <span class="key"><span class="swatch fall"></span> runs on into the next label</span>
  <span class="key"><span class="swatch ending"></span> ending</span>
  <span class="key"><span class="swatch unreachable"></span> nothing reaches it</span>
  <span class="key">click a block to jump to it</span>
  <span class="key" id="summary"></span>
</footer>
<script nonce="${key}" src="${asset('media', 'scenemap.js')}"></script>
</body>
</html>`;
}

/**
 * One scene map panel, following whichever Kiosune script is in front.
 */
function createSceneMap(context, getModel) {
  /** @type {vscode.WebviewPanel | null} */
  let panel = null;
  /** @type {vscode.TextDocument | null} */
  let document = null;
  let ready = false;
  let pendingFit = true;

  const svgFor = (doc) => {
    const { script, graph } = getModel(doc);
    const showFallthrough = vscode.workspace.getConfiguration('kiosune').get('sceneMap.showFallthrough', true);
    const layout = layoutGraph(graph, { showFallthrough: true });
    return {
      svg: renderSceneMap(layout, { sceneOrder: [...script.backgrounds.keys()] }),
      showFallthrough,
      standalone: () => renderSceneMap(layoutGraph(graph, { showFallthrough }), {
        standalone: true,
        title: `Scene map — ${doc.uri.path.split('/').pop()}`,
        sceneOrder: [...script.backgrounds.keys()]
      }),
      summary: `${graph.nodes.size} blocks · ${graph.edges.length} links · ${graph.endings.length} endings`
    };
  };

  const render = (fit = false) => {
    if (!panel || !document || !ready) return;
    const { svg, summary, showFallthrough } = svgFor(document);
    panel.webview.postMessage({ type: 'render', svg, summary, showFallthrough, fit: fit || pendingFit });
    pendingFit = false;
  };

  const exportSvg = async () => {
    if (!document) return;
    const target = document.uri.with({ path: document.uri.path.replace(/(\.kio)?(\.txt)?$/, '') + '-scene-map.svg' });
    await vscode.workspace.fs.writeFile(target, Buffer.from(svgFor(document).standalone(), 'utf8'));
    const open = await vscode.window.showInformationMessage(`Scene map written to ${target.path.split('/').pop()}`, 'Open');
    if (open) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: true });
  };

  const show = (doc) => {
    document = doc;
    if (!panel) {
      panel = vscode.window.createWebviewPanel('kiosune.sceneMap', 'Kiosune scene map', {
        viewColumn: vscode.ViewColumn.Beside, preserveFocus: true
      }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity-icon.svg');
      panel.webview.html = html(panel.webview, context.extensionUri);
      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'ready') { ready = true; render(true); }
        if (message.type === 'export') await exportSvg();
        if (message.type === 'reveal' && document) {
          const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
          const position = new vscode.Position(Math.max(0, message.line), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
      }, null, context.subscriptions);
      panel.onDidDispose(() => { panel = null; ready = false; pendingFit = true; }, null, context.subscriptions);
    } else {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    panel.title = `Scene map — ${doc.uri.path.split('/').pop()}`;
    render(true);
  };

  return {
    show,
    isOpen: () => Boolean(panel),
    update(doc) {
      if (!panel || !doc) return;
      if (document && doc.uri.toString() !== document.uri.toString() && doc.languageId !== 'kiosune') return;
      if (doc.languageId !== 'kiosune') return;
      document = doc;
      panel.title = `Scene map — ${doc.uri.path.split('/').pop()}`;
      render();
    },
    highlight(doc, line) {
      if (!panel || !ready || !document || doc.uri.toString() !== document.uri.toString()) return;
      if (!vscode.workspace.getConfiguration('kiosune').get('sceneMap.followCursor', true)) return;
      const { script } = getModel(doc);
      const block = blockAt(script, line);
      panel.webview.postMessage({ type: 'highlight', id: block ? (block.label || '«start»') : null });
    },
    exportSvg(doc) {
      document = doc || document;
      return exportSvg();
    }
  };
}

module.exports = { createSceneMap };
