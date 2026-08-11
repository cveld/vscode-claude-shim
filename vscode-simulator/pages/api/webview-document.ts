import type { NextApiRequest, NextApiResponse } from "next";
import { getShimSession } from "@/simulator-lib/shimSession";

// Serve the real host-produced webview HTML as a standalone, same-origin document to load in
// an <iframe>. Running the bundle in its own document (rather than in-page) gives it a real
// viewport, so its full-height flex layout, fixed-position popovers, and the composer input all
// behave correctly and its CSS stays isolated from the simulator shell.
//
// Transforms applied to the captured host HTML:
//  - file:///…/webview/*  ->  /webview/*   (browser can't load file://; served same-origin)
//  - CSP relaxed to same-origin so the assets, the module chunks, and the injected bridge load,
//    and connect-src 'self' allows the bridge's fetch + EventSource back to the simulator.
//  - a bridge <script> (reusing the document nonce) injected before the bundle so
//    acquireVsCodeApi() exists and messages relay to/from the live shim session directly.
// VS Code "Dark Modern" values for the 247 distinct --vscode-* custom properties referenced by
// webview/index.css. The real workbench injects these onto the webview root; the simulator has no
// workbench, so without them every var(--vscode-…) resolves to nothing. Regenerate the variable
// list with: grep -oE '\-\-vscode-[a-zA-Z0-9-]+' webview/index.css | sort -u
const DARK_MODERN_THEME_CSS = `:root {
--vscode-actionBar-toggledBackground: #383a49;
--vscode-badge-background: #4d4d4d;
--vscode-badge-foreground: #ffffff;
--vscode-banner-background: #04395e;
--vscode-banner-foreground: #ffffff;
--vscode-banner-iconForeground: #3794ff;
--vscode-button-background: #0078d4;
--vscode-button-border: transparent;
--vscode-button-foreground: #ffffff;
--vscode-button-hoverBackground: #1177bb;
--vscode-button-secondaryBackground: #313131;
--vscode-button-secondaryForeground: #cccccc;
--vscode-button-secondaryHoverBackground: #3c3c3c;
--vscode-button-separator: #ffffff66;
--vscode-charts-blue: #3794ff;
--vscode-charts-foreground: #cccccc;
--vscode-charts-green: #89d185;
--vscode-charts-orange: #d18616;
--vscode-charts-purple: #b180d7;
--vscode-charts-red: #f14c4c;
--vscode-charts-yellow: #cca700;
--vscode-chat-font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif;
--vscode-chat-font-size: 13px;
--vscode-chat-slashCommandBackground: #264f78;
--vscode-chat-slashCommandForeground: #3794ff;
--vscode-contrastActiveBorder: #0078d4;
--vscode-contrastBorder: #00000000;
--vscode-descriptionForeground: #9d9d9d;
--vscode-diffEditor-border: #444444;
--vscode-diffEditor-diagonalFill: #cccccc03;
--vscode-diffEditor-insertedLineBackground: #9ccc2c33;
--vscode-diffEditor-insertedTextBackground: #9ccc2c4d;
--vscode-diffEditor-insertedTextBorder: #00000000;
--vscode-diffEditor-move-border: #cca700ab;
--vscode-diffEditor-moveActive-border: #ffa500;
--vscode-diffEditor-removedLineBackground: #ff000033;
--vscode-diffEditor-removedTextBackground: #ff00004d;
--vscode-diffEditor-removedTextBorder: #00000000;
--vscode-diffEditor-unchangedCodeBackground: #00000000;
--vscode-diffEditor-unchangedRegionBackground: #00000000;
--vscode-diffEditor-unchangedRegionForeground: #cccccc99;
--vscode-diffEditor-unchangedRegionShadow: #000000;
--vscode-diffEditorGutter-insertedLineBackground: #9ccc2c33;
--vscode-diffEditorGutter-removedLineBackground: #ff000033;
--vscode-disabledForeground: #cccccc80;
--vscode-editor-background: #1f1f1f;
--vscode-editor-findMatchBackground: #9e6a03;
--vscode-editor-findMatchBorder: #f38518;
--vscode-editor-findMatchHighlightBackground: #ea5c0055;
--vscode-editor-findRangeHighlightBackground: #3a3d4166;
--vscode-editor-foldBackground: #264f784d;
--vscode-editor-foldPlaceholderForeground: #808080;
--vscode-editor-font-family: "Droid Sans Mono", monospace, monospace;
--vscode-editor-font-size: 13px;
--vscode-editor-foreground: #cccccc;
--vscode-editor-hoverHighlightBackground: #264f7840;
--vscode-editor-inactiveSelectionBackground: #3a3d4166;
--vscode-editor-lineHighlightBackground: #2a2d2e;
--vscode-editor-linkedEditingBackground: #ff00004d;
--vscode-editor-placeholder-foreground: #a6a6a6;
--vscode-editor-rangeHighlightBackground: #ffffff0b;
--vscode-editor-rangeHighlightBorder: #ffffff00;
--vscode-editor-selectionBackground: #264f78;
--vscode-editor-selectionHighlightBackground: #add6ff26;
--vscode-editor-selectionHighlightBorder: #00000000;
--vscode-editor-snippetFinalTabstopHighlightBackground: #525252;
--vscode-editor-snippetFinalTabstopHighlightBorder: #c8c8c8;
--vscode-editor-snippetTabstopHighlightBackground: #7c7c7c4d;
--vscode-editor-snippetTabstopHighlightBorder: #7c7c7c;
--vscode-editor-symbolHighlightBackground: #ea5c0055;
--vscode-editor-symbolHighlightBorder: #ea5c0000;
--vscode-editor-wordHighlightBackground: #575757b8;
--vscode-editor-wordHighlightBorder: #757575b8;
--vscode-editor-wordHighlightStrongBackground: #004972b8;
--vscode-editor-wordHighlightStrongBorder: #007accb8;
--vscode-editor-wordHighlightTextBackground: #575757b8;
--vscode-editor-wordHighlightTextBorder: #757575b8;
--vscode-editorActionList-background: #252526;
--vscode-editorActionList-focusBackground: #04395e;
--vscode-editorActionList-focusForeground: #ffffff;
--vscode-editorActionList-foreground: #cccccc;
--vscode-editorBracketMatch-background: #0064001a;
--vscode-editorBracketMatch-border: #888888;
--vscode-editorCodeLens-fontFamily: inherit;
--vscode-editorCodeLens-fontFamilyDefault: var(--vscode-editor-font-family);
--vscode-editorCodeLens-fontFeatureSettings: "liga" off, "calt" off;
--vscode-editorCodeLens-fontSize: 90%;
--vscode-editorCodeLens-foreground: #999999;
--vscode-editorCodeLens-lineHeight: 0;
--vscode-editorCursor-foreground: #aeafad;
--vscode-editorError-background: #f14c4c1a;
--vscode-editorError-border: #f14c4c00;
--vscode-editorGhostText-background: #ffffff08;
--vscode-editorGhostText-border: #ffffff00;
--vscode-editorGhostText-foreground: #ffffff56;
--vscode-editorGutter-background: #1f1f1f;
--vscode-editorGutter-commentRangeForeground: #c5c5c5;
--vscode-editorGutter-foldingControlForeground: #c5c5c5;
--vscode-editorHint-border: #eeeeeeb3;
--vscode-editorHoverWidget-background: #252526;
--vscode-editorHoverWidget-border: #454545;
--vscode-editorHoverWidget-foreground: #cccccc;
--vscode-editorHoverWidget-highlightForeground: #2aaaff;
--vscode-editorHoverWidget-statusBarBackground: #2c2c2d;
--vscode-editorInfo-background: #3794ff1a;
--vscode-editorInfo-border: #3794ff00;
--vscode-editorLightBulb-foreground: #ffcc00;
--vscode-editorLightBulbAi-foreground: #ffcc00;
--vscode-editorLightBulbAutoFix-foreground: #75beff;
--vscode-editorLineNumber-activeForeground: #c6c6c6;
--vscode-editorLineNumber-foreground: #6e7681;
--vscode-editorLink-activeForeground: #4daafc;
--vscode-editorMarkerNavigationInfo-headerBackground: #3794ff1a;
--vscode-editorRuler-foreground: #5a5a5a;
--vscode-editorStickyScroll-background: #1f1f1f;
--vscode-editorStickyScroll-border: #ffffff1a;
--vscode-editorStickyScroll-foldingOpacityTransition: 0.25s;
--vscode-editorStickyScroll-scrollableWidth: 100%;
--vscode-editorStickyScroll-shadow: #00000066;
--vscode-editorStickyScrollHover-background: #2a2d2e;
--vscode-editorSuggestWidget-background: #252526;
--vscode-editorSuggestWidget-border: #454545;
--vscode-editorSuggestWidget-focusHighlightForeground: #2aaaff;
--vscode-editorSuggestWidget-foreground: #cccccc;
--vscode-editorSuggestWidget-highlightForeground: #2aaaff;
--vscode-editorSuggestWidget-selectedForeground: #ffffff;
--vscode-editorSuggestWidget-selectedIconForeground: #ffffff;
--vscode-editorSuggestWidgetStatus-foreground: #ccccccb3;
--vscode-editorUnicodeHighlight-background: #bd973940;
--vscode-editorUnicodeHighlight-border: #cea33d;
--vscode-editorUnnecessaryCode-border: #00000000;
--vscode-editorWarning-background: #cca7001a;
--vscode-editorWarning-border: #cca70000;
--vscode-editorWhitespace-foreground: #e3e4e229;
--vscode-editorWidget-background: #252526;
--vscode-editorWidget-border: #454545;
--vscode-editorWidget-foreground: #cccccc;
--vscode-editorWidget-resizeBorder: #0078d4;
--vscode-errorForeground: #f48771;
--vscode-focusBorder: #0078d4;
--vscode-foreground: #cccccc;
--vscode-gitDecoration-addedResourceForeground: #81b88b;
--vscode-gitDecoration-deletedResourceForeground: #c74e39;
--vscode-hover-maxWidth: 500px;
--vscode-hover-sourceWhiteSpace: pre;
--vscode-hover-whiteSpace: nowrap;
--vscode-icon-foreground: #c5c5c5;
--vscode-icon-x-content: '\\ea76';
--vscode-icon-x-font-family: codicon;
--vscode-inlineChatInput-border: #454545;
--vscode-input-background: #313131;
--vscode-input-border: #3c3c3c;
--vscode-input-foreground: #cccccc;
--vscode-input-placeholderForeground: #989898;
--vscode-inputOption-activeBorder: #0078d4;
--vscode-inputOption-hoverBackground: #5a5d5e80;
--vscode-inputValidation-infoBorder: #3794ff;
--vscode-keybindingLabel-background: #8080802b;
--vscode-keybindingLabel-border: #33333399;
--vscode-keybindingLabel-bottomBorder: #44444499;
--vscode-keybindingLabel-foreground: #cccccc;
--vscode-list-activeSelectionBackground: #04395e;
--vscode-list-activeSelectionForeground: #ffffff;
--vscode-list-focusHighlightForeground: #2aaaff;
--vscode-list-highlightForeground: #2aaaff;
--vscode-list-hoverBackground: #2a2d2e;
--vscode-menu-background: #252526;
--vscode-menu-border: #454545;
--vscode-menu-foreground: #cccccc;
--vscode-menu-selectionBackground: #04395e;
--vscode-menu-selectionBorder: #00000000;
--vscode-menu-selectionForeground: #ffffff;
--vscode-minimapSlider-activeBackground: #bfbfbf33;
--vscode-minimapSlider-background: #79797933;
--vscode-minimapSlider-hoverBackground: #646464b3;
--vscode-multiDiffEditor-background: #1f1f1f;
--vscode-multiDiffEditor-border: #454545;
--vscode-multiDiffEditor-headerBackground: #2d2d2d;
--vscode-notifications-background: #252526;
--vscode-panel-border: #80808059;
--vscode-parameterHintsWidget-editorFontFamily: var(--vscode-editor-font-family);
--vscode-parameterHintsWidget-editorFontFamilyDefault: var(--vscode-editor-font-family);
--vscode-peekViewEditor-background: #001f33;
--vscode-peekViewEditor-matchHighlightBackground: #ff8f0099;
--vscode-peekViewEditor-matchHighlightBorder: #ee931e;
--vscode-peekViewEditorGutter-background: #001f33;
--vscode-peekViewEditorStickyScroll-background: #001f33;
--vscode-peekViewResult-background: #252526;
--vscode-peekViewResult-fileForeground: #ffffff;
--vscode-peekViewResult-lineForeground: #bbbbbb;
--vscode-peekViewResult-matchHighlightBackground: #ea5c0055;
--vscode-peekViewResult-selectionBackground: #3399ff33;
--vscode-peekViewResult-selectionForeground: #ffffff;
--vscode-problemsErrorIcon-foreground: #f14c4c;
--vscode-problemsInfoIcon-foreground: #3794ff;
--vscode-problemsWarningIcon-foreground: #cca700;
--vscode-progressBar-background: #0e70c0;
--vscode-sash-hover-size: 4px;
--vscode-sash-hoverBorder: #0078d4;
--vscode-sash-size: 4px;
--vscode-scrollbar-shadow: #000000;
--vscode-scrollbarSlider-activeBackground: #bfbfbf66;
--vscode-scrollbarSlider-background: #79797966;
--vscode-scrollbarSlider-hoverBackground: #646464b3;
--vscode-sideBar-background: #181818;
--vscode-sideBarActivityBarTop-border: #606060;
--vscode-sideBarSectionHeader-border: #ffffff1f;
--vscode-symbolIcon-arrayForeground: #cccccc;
--vscode-symbolIcon-booleanForeground: #cccccc;
--vscode-symbolIcon-classForeground: #ee9d28;
--vscode-symbolIcon-colorForeground: #cccccc;
--vscode-symbolIcon-constantForeground: #cccccc;
--vscode-symbolIcon-constructorForeground: #b180d7;
--vscode-symbolIcon-enumeratorForeground: #ee9d28;
--vscode-symbolIcon-enumeratorMemberForeground: #75beff;
--vscode-symbolIcon-eventForeground: #ee9d28;
--vscode-symbolIcon-fieldForeground: #75beff;
--vscode-symbolIcon-fileForeground: #cccccc;
--vscode-symbolIcon-folderForeground: #cccccc;
--vscode-symbolIcon-functionForeground: #b180d7;
--vscode-symbolIcon-interfaceForeground: #75beff;
--vscode-symbolIcon-keyForeground: #cccccc;
--vscode-symbolIcon-keywordForeground: #cccccc;
--vscode-symbolIcon-methodForeground: #b180d7;
--vscode-symbolIcon-moduleForeground: #cccccc;
--vscode-symbolIcon-namespaceForeground: #cccccc;
--vscode-symbolIcon-nullForeground: #cccccc;
--vscode-symbolIcon-numberForeground: #cccccc;
--vscode-symbolIcon-objectForeground: #cccccc;
--vscode-symbolIcon-operatorForeground: #cccccc;
--vscode-symbolIcon-packageForeground: #cccccc;
--vscode-symbolIcon-propertyForeground: #cccccc;
--vscode-symbolIcon-referenceForeground: #cccccc;
--vscode-symbolIcon-snippetForeground: #cccccc;
--vscode-symbolIcon-stringForeground: #cccccc;
--vscode-symbolIcon-structForeground: #cccccc;
--vscode-symbolIcon-textForeground: #cccccc;
--vscode-symbolIcon-typeParameterForeground: #cccccc;
--vscode-symbolIcon-unitForeground: #cccccc;
--vscode-symbolIcon-variableForeground: #75beff;
--vscode-terminal-ansiCyan: #29b8db;
--vscode-textCodeBlock-background: #0a0a0a66;
--vscode-textLink-activeForeground: #4daafc;
--vscode-textLink-foreground: #4daafc;
--vscode-toolbar-hoverBackground: #5a5d5e80;
--vscode-widget-border: #454545;
--vscode-widget-shadow: #0000005c;
}`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const viewId = typeof req.query.viewId === "string" ? req.query.viewId : "claudeVSCodeSidebar";

  try {
    const session = await getShimSession();
    const hostHtml = session.htmlForView(viewId);
    if (!hostHtml) {
      return res.status(404).json({ error: `No host HTML captured for view ${viewId}`, viewIds: session.viewIds() });
    }

    const nonce = hostHtml.match(/nonce-([A-Za-z0-9+/=]+)/)?.[1] ?? "";

    let html = hostHtml
      // Point file:// asset references at the same-origin /webview/ prefix.
      .replace(/file:\/\/\/[^"']*?\/webview\//g, "/webview/")
      // Relax the CSP for same-origin hosting (the original targets the vscode-webview: scheme).
      .replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; worker-src 'self' blob:;">`,
      );

    // Inject the VS Code theme variables into <head> so var(--vscode-…) references resolve.
    // The real workbench sets these on the webview root; we have no workbench, so without them
    // the caret is invisible and panes render transparent. CSP already allows 'unsafe-inline' styles.
    html = html.replace(/<\/head>/i, `<style>${DARK_MODERN_THEME_CSS}</style>\n</head>`);

    const bridge = buildBridgeScript(viewId, nonce);
    // Inject right after <body> so the classic bridge script runs before the deferred module.
    html = html.replace(/<body>/, `<body>\n${bridge}`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(html);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

function buildBridgeScript(viewId: string, nonce: string): string {
  const viewIdJson = JSON.stringify(viewId);
  return `<script nonce="${nonce}">
(function () {
  var VIEW_ID = ${viewIdJson};
  var STORAGE_KEY = "vscode-simulator.webview-state." + VIEW_ID;
  var chain = Promise.resolve();
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        chain = chain.then(function () {
          return fetch("/api/webview-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ viewId: VIEW_ID, message: message }),
          });
        }).catch(function () {});
      },
      setState: function (state) {
        try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
        return state;
      },
      getState: function () {
        try { var raw = sessionStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : undefined; } catch (e) { return undefined; }
      },
    };
  };
  var es = new EventSource("/api/webview-stream?viewId=" + encodeURIComponent(VIEW_ID));
  es.onmessage = function (ev) {
    try {
      var payload = JSON.parse(ev.data);
      window.dispatchEvent(new MessageEvent("message", { data: payload.message }));
    } catch (e) {}
  };
})();
</script>`;
}
