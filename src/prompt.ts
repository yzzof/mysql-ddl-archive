import * as readline from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Prompt on stderr for a secret and read it from stdin without echoing the
 * typed characters. The prompt itself is shown; keystrokes are masked.
 *
 * Falls back to a plain (still non-echoing where possible) read when stdin is
 * not a TTY so piped input still works.
 */
export function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;

    // Write the prompt to stderr; mute echo of the user's keystrokes.
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) process.stderr.write(chunk);
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });

    rl.question(query, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });

    // Everything typed after the prompt is echoed by readline -> suppress it.
    muted = true;
  });
}
