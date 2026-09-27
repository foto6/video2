import { spawn } from "node:child_process";

export function createProcessExecutor({ spawnImpl = spawn } = {}) {
  return {
    run(command) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl(command.binary, command.args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.setEncoding?.("utf8");
        child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ code, stderr });
          else reject(new Error(`${command.binary} exited with code ${code}: ${stderr.slice(-4000)}`));
        });
      });
    }
  };
}
