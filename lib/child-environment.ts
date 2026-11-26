/** Environment inherited by processes that run in a project. */
export function sanitizeProjectCommandEnvironment(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (key === "PORT" || key === "NODE_ENV" || key.startsWith("NEXT_")
      || key === "OMP_FROND_PASSWORD") delete env[name];
  }
  return env;
}

/** Git diagnostics are parsed in English, including worktree removal errors. */
export function projectGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = sanitizeProjectCommandEnvironment(base);
  env.LC_ALL = "C";
  return env;
}
