import { exec } from "node:child_process";

export function catFile(filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // VULNERABILITY: unsanitized user input concatenated directly into a shell command.
    // An attacker can inject arbitrary commands via the filename parameter.
    exec("cat " + filename, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
