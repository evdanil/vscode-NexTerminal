import { renderWebviewDocument } from "./shared/webviewDocument";
import { baseWebviewCss } from "./shared/webviewStyles";

/** Static shell only: session labels arrive as structured data and never enter HTML or script source. */
export function renderSerialSendHtml(nonce: string): string {
  return renderWebviewDocument({
    nonce,
    css: `${baseWebviewCss()}
    body { max-width: 900px; }
    textarea { min-height: 220px; }
    .session-detail, .help { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .send-options { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
    .send-options .form-group { margin-bottom: 0; }
    #send-result { min-height: 1.4em; }
    #connection-state { border-left: 2px solid var(--vscode-focusBorder); padding-left: 10px; }
    `,
    body: `
    <h2>Serial Send Box</h2>
    <p id="profile" class="session-detail"></p>
    <p id="path" class="session-detail"></p>
    <p id="connection-state" role="status">Waiting for session state…</p>
    <label for="draft">Text to send</label>
    <textarea id="draft" spellcheck="false" aria-describedby="ending-help byte-count" placeholder="Enter serial commands. Enter adds a new line."></textarea>
    <div class="send-options">
      <div class="form-group">
        <label for="line-ending">Line ending</label>
        <select id="line-ending">
          <option value="none">None — preserve text</option>
          <option value="cr" selected>CR</option>
          <option value="lf">LF</option>
          <option value="crlf">CRLF</option>
        </select>
      </div>
      <button id="send" type="button" disabled>Send</button>
      <span id="byte-count" class="help"></span>
    </div>
    <div class="form-group form-group-checkbox">
      <label for="keep-text"><input type="checkbox" id="keep-text"> Keep text after sending</label>
    </div>
    <p id="ending-help" class="help"></p>
    <p class="help">Ctrl+Enter or Cmd+Enter sends. Enter adds a new line. Sending writes to the serial driver; the device may not echo or acknowledge it.</p>
    <p class="help">Macro shortcuts, including Alt+S, send to this session while this box has focus.</p>
    <p id="send-result" role="status" aria-live="polite"></p>
    <div class="button-row">
      <button id="focus-terminal" type="button" class="btn-secondary">Focus Terminal</button>
      <button id="direct-input" type="button" class="btn-secondary">Use Direct Terminal Input</button>
    </div>`,
    script: `
    (function () {
      const vscode = acquireVsCodeApi();
      const draft = document.getElementById('draft');
      const ending = document.getElementById('line-ending');
      const sendButton = document.getElementById('send');
      const result = document.getElementById('send-result');
      const keepText = document.getElementById('keep-text');
      // Same grammar as src/macroBindings.ts; anything else from the host is ignored.
      const SHORTCUT = /^(alt|alt\\+shift|ctrl\\+shift)\\+([a-z0-9])$/;
      let shortcuts = [];
      let state;
      let revision = 0;
      let requestId = 0;
      let pending;
      let composing = false;

      function convertedText() {
        const eol = ending.value === 'cr' ? '\\r' : ending.value === 'lf' ? '\\n' : ending.value === 'crlf' ? '\\r\\n' : '';
        return ending.value === 'none' ? draft.value : draft.value.replace(/\\r\\n|\\r|\\n/g, eol) + eol;
      }
      function endingHelp(value) {
        if (value === 'none') return 'None preserves text exactly, with no appended line ending.';
        const name = value.toUpperCase();
        const conversion = 'Normalizes every line break to ' + name + ' and appends one more, even after a final line break.';
        if (value === 'cr') return 'CR matches pressing Enter in the terminal and is what most device consoles use to run a command. ' + conversion;
        const symptom = value === 'lf'
          ? 'A console that runs commands on CR may echo LF-terminated text without running it.'
          : 'A console that runs commands on CR may show an extra blank line or prompt.';
        return conversion + ' Choose ' + name + ' only when the device expects it. ' + symptom;
      }
      // A bound macro combo is dispatched by VS Code from the forwarded keydown,
      // which happens whatever this page does; on macOS Option+letter would also
      // type a character (å, ß) into the draft. Suppress only that default action,
      // and never stop propagation: the forwarded keydown is what runs the macro.
      // The physical key (event.code) and the layout-mapped key code must both
      // name the combo's key, so a layout where they disagree is never blocked
      // from typing; AltGr (Ctrl+Alt) never matches an Alt or Ctrl+Shift combo.
      function shortcutOf(event) {
        if (event.isComposing || event.keyCode === 229 || event.metaKey) return undefined;
        const match = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(typeof event.code === 'string' ? event.code : '');
        if (!match) return undefined;
        const key = match[1] || match[2];
        if (event.keyCode !== key.charCodeAt(0)) return undefined;
        const modifiers = event.ctrlKey
          ? (event.shiftKey && !event.altKey ? 'ctrl+shift' : undefined)
          : event.altKey ? (event.shiftKey ? 'alt+shift' : 'alt') : undefined;
        return modifiers && modifiers + '+' + key.toLowerCase();
      }
      function refresh() {
        const payload = convertedText();
        const bytes = new TextEncoder().encode(payload).length;
        document.getElementById('byte-count').textContent = bytes + ' / 65,536 UTF-8 bytes';
        document.getElementById('ending-help').textContent = endingHelp(ending.value);
        sendButton.disabled = !!pending || composing || !state || !state.connected || state.inputLocked || !state.dedicatedInputEnabled || bytes === 0 || bytes > 65536;
        sendButton.textContent = pending ? 'Sending…' : 'Send';
      }
      function submit() {
        refresh();
        if (sendButton.disabled) return;
        pending = { requestId: ++requestId, revision: revision, epoch: state.connectionEpoch, keep: keepText.checked === true };
        result.textContent = 'Writing to serial driver…';
        const message = { type: 'send', requestId: pending.requestId, connectionEpoch: pending.epoch, text: draft.value, lineEnding: ending.value };
        refresh();
        vscode.postMessage(message);
      }
      draft.addEventListener('input', function () { revision++; refresh(); });
      ending.addEventListener('change', function () { revision++; refresh(); });
      draft.addEventListener('compositionstart', function () { composing = true; refresh(); });
      draft.addEventListener('compositionend', function () { composing = false; revision++; refresh(); });
      draft.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || composing || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        submit();
      });
      document.addEventListener('keydown', function (event) {
        const combo = shortcutOf(event);
        if (combo && shortcuts.indexOf(combo) !== -1) event.preventDefault();
      });
      keepText.addEventListener('change', function () { vscode.postMessage({ type: 'setKeepText', keepText: keepText.checked === true }); });
      window.addEventListener('focus', function () { vscode.postMessage({ type: 'focusChanged', focused: true }); });
      window.addEventListener('blur', function () { vscode.postMessage({ type: 'focusChanged', focused: false }); });
      sendButton.addEventListener('click', submit);
      document.getElementById('focus-terminal').addEventListener('click', function () { vscode.postMessage({ type: 'focusTerminal' }); });
      document.getElementById('direct-input').addEventListener('click', function () { vscode.postMessage({ type: 'useDirectInput' }); });
      window.addEventListener('message', function (event) {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'state') {
          state = message;
          document.getElementById('profile').textContent = message.profileName;
          document.getElementById('path').textContent = message.path || 'No serial port currently selected';
          document.getElementById('connection-state').textContent = !message.connected
            ? 'Serial session: ' + message.status
            : message.inputLocked ? 'Serial input locked by a script. Use Nexus: Stop Script or the terminal lock indicator.'
            : !message.dedicatedInputEnabled ? 'Direct terminal input is enabled.'
            : 'Connected — dedicated input enabled';
          refresh();
        } else if (message.type === 'sendResult' && pending && message.requestId === pending.requestId) {
          const submitted = pending;
          pending = undefined;
          const sameConnection = state && state.connectionEpoch === submitted.epoch;
          if (message.ok === true) {
            if (!submitted.keep && !composing && sameConnection && revision === submitted.revision) { draft.value = ''; revision++; }
            result.textContent = sameConnection ? 'Written to serial driver' : 'Connection changed. Delivery may be partial or unknown; review before retrying.';
          } else {
            result.textContent = message.error || 'Delivery may be partial or unknown; review before retrying.';
          }
          refresh();
        } else if (message.type === 'preferences' && typeof message.keepText === 'boolean') {
          keepText.checked = message.keepText;
        } else if (message.type === 'macroShortcuts' && Array.isArray(message.shortcuts) && message.shortcuts.length <= 128 &&
            message.shortcuts.every(function (combo) { return typeof combo === 'string' && SHORTCUT.test(combo); })) {
          shortcuts = message.shortcuts.slice();
        }
      });
      refresh();
      vscode.postMessage({ type: 'ready' });
      // The focus event can fire before this script runs, so report the current state once.
      vscode.postMessage({ type: 'focusChanged', focused: document.hasFocus() === true });
    })();`
  });
}
