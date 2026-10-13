const rootDirectory = `${import.meta.dir}/..`;
const webuiDirectory = `${rootDirectory}/webui`;
const bunExecutable = process.execPath;

const children = [
  Bun.spawn([bunExecutable, "run", "--hot", "src/index.ts"], {
    cwd: rootDirectory,
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn([bunExecutable, "run", "dev"], {
    cwd: webuiDirectory,
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let stopping = false;

function stopChildren() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

process.on("SIGINT", stopChildren);
process.on("SIGTERM", stopChildren);

try {
  await Promise.race(children.map((child) => child.exited));
} finally {
  stopChildren();
}
