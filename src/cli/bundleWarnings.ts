import chalk from "chalk";

export function warnIfOversizeBundle(
  estimatedTokens: number,
  threshold = 196_000,
  log: (message: string) => void = console.log,
): boolean {
  if (Number.isNaN(estimatedTokens) || estimatedTokens <= threshold) {
    return false;
  }
  const msg = `Advisory: bundle is ~${estimatedTokens.toLocaleString()} tokens (>${threshold.toLocaleString()}). Treat this as an estimate only; do not shrink browser-mode context unless the user asks or the UI/API returns a hard rejection.`;
  log(chalk.red(msg));
  return true;
}
