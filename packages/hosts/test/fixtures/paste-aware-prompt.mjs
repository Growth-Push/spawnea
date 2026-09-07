// Deterministic interactive fixture: Enter during a text burst inserts a newline.
// Models the paste detection used by terminal prompt editors, without a model call.
process.stdin.setRawMode(true);
process.stdin.resume();
let text = '';
let lastTextAt = 0;
process.stdout.write('PROMPT_READY\r\n');
process.stdin.on('data', (chunk) => {
  for (const character of chunk.toString('utf8')) {
    if (character === '\r' && Date.now() - lastTextAt > 100) {
      process.stdout.write(`SUBMITTED:${JSON.stringify(text.split('\x1b[200~').join('').split('\x1b[201~').join(''))}\r\n`);
      text = '';
    } else {
      text += character === '\r' ? '\n' : character;
      lastTextAt = Date.now();
    }
  }
});
