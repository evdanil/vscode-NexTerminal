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
          <option value="cr">CR</option>
          <option value="lf">LF</option>
          <option value="crlf">CRLF</option>
        </select>
      </div>
      <button id="send" type="button" disabled>Send</button>
      <span id="byte-count" class="help"></span>
    </div>
    <p id="ending-help" class="help"></p>
    <p class="help">Ctrl+Enter or Cmd+Enter sends. Enter adds a new line. Sending writes to the serial driver; the device may not echo or acknowledge it.</p>
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
      let state;
      let revision = 0;
      let requestId = 0;
      let pending;
      let composing = false;

      function convertedText() {
        const eol = ending.value === 'cr' ? '\\r' : ending.value === 'lf' ? '\\n' : ending.value === 'crlf' ? '\\r\\n' : '';
        return ending.value === 'none' ? draft.value : draft.value.replace(/\\r\\n|\\r|\\n/g, eol) + eol;
      }
      function refresh() {
        const payload = convertedText();
        const bytes = new TextEncoder().encode(payload).length;
        document.getElementById('byte-count').textContent = bytes + ' / 65,536 UTF-8 bytes';
        document.getElementById('ending-help').textContent = ending.value === 'none'
          ? 'None preserves text exactly, with no appended line ending.'
          : 'Normalize every line break to ' + ending.value.toUpperCase() + ' and append one final line ending, even after an existing final line break.';
        sendButton.disabled = !!pending || composing || !state || !state.connected || state.inputLocked || !state.dedicatedInputEnabled || bytes === 0 || bytes > 65536;
        sendButton.textContent = pending ? 'Sending…' : 'Send';
      }
      function submit() {
        refresh();
        if (sendButton.disabled) return;
        pending = { requestId: ++requestId, revision: revision, epoch: state.connectionEpoch };
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
            if (!composing && sameConnection && revision === submitted.revision) { draft.value = ''; revision++; }
            result.textContent = sameConnection ? 'Written to serial driver' : 'Connection changed. Delivery may be partial or unknown; review before retrying.';
          } else {
            result.textContent = message.error || 'Delivery may be partial or unknown; review before retrying.';
          }
          refresh();
        }
      });
      refresh();
      vscode.postMessage({ type: 'ready' });
    })();`
  });
}
