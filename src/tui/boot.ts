/**
 * The boot sequence (ADR-0012): bare `patchwork-harness` powers on with the ASCII
 * wordmark and the REAL preflight from boot() lighting up as each check
 * genuinely completes. HONEST BY CONSTRUCTION — this renders boot()'s
 * actual results; a failure paints red and halts with the fix hint. A
 * boot animation that can only ever look successful would be the
 * can-only-report-green shape in cosmetics.
 */
import { BOLD, CLEAR_SCREEN, FG, RESET, moveTo, paint } from "./ansi.js";
import type { Screen } from "./screen.js";

/** Hand-drawn — no figlet dep. 6 rows, 62 cols. */
export const WORDMARK = [
  " █████╗ ██╗ ██████╗ ██████╗  ██████╗██╗  ██╗",
  "██╔══██╗██║██╔═══██╗██╔══██╗██╔════╝██║  ██║",
  "███████║██║██║   ██║██████╔╝██║     ███████║",
  "██╔══██║██║██║   ██║██╔══██╗██║     ██╔══██║",
  "██║  ██║██║╚██████╔╝██║  ██║╚██████╗██║  ██║",
  "╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝",
] as const;
export const TAGLINE = "AI ORCHESTRATOR — patchwork-audited multi-LLM agent";

export interface BootCheck {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Render the wordmark, then run the real preflight, painting each check
 * as its result ARRIVES. Returns boot()'s verdict; on failure the caller
 * must not open the cockpit.
 */
export async function playBoot(
  out: NodeJS.WriteStream,
  runBoot: () => Promise<{ ok: boolean; checks: BootCheck[] }>,
  opts: { cols?: number; animate?: boolean } = {},
): Promise<{ ok: boolean; checks: BootCheck[] }> {
  const cols = opts.cols ?? out.columns ?? 80;
  const animate = opts.animate ?? true;
  const left = Math.max(1, Math.floor((cols - WORDMARK[0].length) / 2) + 1);
  out.write(CLEAR_SCREEN);
  for (let i = 0; i < WORDMARK.length; i++) {
    out.write(moveTo(2 + i, left) + paint(FG.amber, WORDMARK[i] ?? ""));
    if (animate) await sleep(60);
  }
  const tagLeft = Math.max(1, Math.floor((cols - TAGLINE.length) / 2) + 1);
  out.write(moveTo(9, tagLeft) + paint(FG.amberDim, TAGLINE));
  const baseRow = 11;
  out.write(moveTo(baseRow, left) + paint(FG.dim, "power-on self test"));

  // Run the REAL preflight while a spinner ticks — results paint as truth.
  const spinnerChars = ["|", "/", "-", "\\"];
  let spin = 0;
  const spinner = setInterval(() => {
    out.write(moveTo(baseRow, left + 20) + paint(FG.amber, spinnerChars[spin++ % 4] ?? "|"));
  }, 90);
  let result: { ok: boolean; checks: BootCheck[] };
  try {
    result = await runBoot();
  } catch (err) {
    result = {
      ok: false,
      checks: [
        { name: "boot", ok: false, detail: err instanceof Error ? err.message : String(err) },
      ],
    };
  } finally {
    clearInterval(spinner);
    out.write(moveTo(baseRow, left + 20) + " ");
  }
  for (let i = 0; i < result.checks.length; i++) {
    const c = result.checks[i] as BootCheck;
    const mark = c.ok ? paint(FG.green, "▮ ONLINE ") : paint(FG.red, "▮ FAILED ");
    out.write(
      moveTo(baseRow + 1 + i, left) +
        mark +
        paint(FG.bright, c.name) +
        (c.detail ? paint(FG.dim, ` — ${c.detail}`.slice(0, cols - left - 20)) : ""),
    );
    if (!c.ok && c.fix)
      out.write(
        moveTo(baseRow + 2 + i, left + 2) +
          paint(FG.yellow, `→ ${c.fix}`.slice(0, cols - left - 4)),
      );
    if (animate) await sleep(90);
  }
  const doneRow = baseRow + result.checks.length + 2;
  out.write(
    moveTo(doneRow, left) +
      (result.ok
        ? paint(FG.amber, `${BOLD}ALL SYSTEMS GO${RESET}`)
        : paint(FG.red, `${BOLD}BOOT HALTED${RESET}`)),
  );
  if (animate) await sleep(result.ok ? 500 : 1500);
  return result;
}
