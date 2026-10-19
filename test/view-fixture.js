'use strict';
const protocol = require('../shared/protocol');
// Feature tests send through the same session envelope as the browser bridge.
function connectActions(events, webview) {
  const fire = events.fire.bind(events); let sequence = 0;
  events.fire = payload => {
    const session = /name="reader-session" content="([^"]+)"/.exec(webview.html)?.[1];
    fire(protocol.envelope(session, ++sequence, 'action', payload));
  };
}
module.exports = { connectActions };
