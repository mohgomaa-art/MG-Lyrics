const { execSync } = require("child_process");
const port = process.argv[2];
if (!port) process.exit(0);

try {
  const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
    encoding: "utf8",
  });
  const pids = [...new Set(out.trim().split("\n").map((l) => l.trim().split(/\s+/).pop()))];
  for (const pid of pids) {
    try { execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" }); } catch {}
  }
} catch {}
