import sharp from "sharp";
import { writeFile } from "node:fs/promises";

const W = 1600, H = 900;
const BG = "#0b0e0d", SURF = "#121716", SURF2 = "#0f1413", BORDER = "#243029";
const TEXT = "#ecf1f0", MUTED = "#8d9a97", DIM = "#5d6a67";
const LIME = "#c6f806", ALLOW = "#2fd08a", CLAMP = "#f5b301", DENY = "#ff5c5c";
const MONO = "'DejaVu Sans Mono','JetBrains Mono',monospace";
const SANS = "'DejaVu Sans','Inter',sans-serif";

// breaker-loop mark (32x32 source)
const mark = (x, y, s, color = LIME) => `
<g transform="translate(${x},${y}) scale(${s / 32})">
  <path d="M26.19 11.88 A 11 11 0 1 0 26.19 20.12" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
  <line x1="26.19" y1="20.12" x2="30.5" y2="9.2" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
  <circle cx="26.19" cy="11.88" r="2.4" fill="${color}"/>
</g>`;

const card = (x, y, w, h, step, role, title, accent, body) => {
  const bodyLines = body.map((t, i) =>
    `<text x="${x + 28}" y="${y + 196 + i * 30}" font-family="${MONO}" font-size="17" fill="${MUTED}">${t}</text>`
  ).join("");
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${SURF}" stroke="${BORDER}"/>
  <rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>
  <text x="${x + 28}" y="${y + 44}" font-family="${MONO}" font-size="15" letter-spacing="2" fill="${DIM}">${step}</text>
  <text x="${x + 28}" y="${y + 100}" font-family="${SANS}" font-size="34" font-weight="700" fill="${TEXT}">${title}</text>
  <text x="${x + 28}" y="${y + 140}" font-family="${MONO}" font-size="16" letter-spacing="3" fill="${accent}">${role}</text>
  <line x1="${x + 28}" y1="${y + 162}" x2="${x + w - 28}" y2="${y + 162}" stroke="${BORDER}"/>
  ${bodyLines}`;
};

const chev = (cx, cy, color = LIME) =>
  `<path d="M${cx - 9} ${cy - 14} L${cx + 9} ${cy} L${cx - 9} ${cy + 14}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;

const PAD = 64;
const cw = 450, gap = 59, cy0 = 232, ch = 348;
const x1 = PAD, x2 = x1 + cw + gap, x3 = x2 + cw + gap;

const verdictY = 624;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#glow)"/>
  <defs>
    <radialGradient id="glow" cx="18%" cy="6%" r="90%">
      <stop offset="0%" stop-color="#c6f806" stop-opacity="0.07"/>
      <stop offset="55%" stop-color="#0b0e0d" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- header -->
  ${mark(PAD, 44, 46)}
  <text x="${PAD + 64}" y="84" font-family="${SANS}" font-size="34" font-weight="700" letter-spacing="0.5" fill="${TEXT}">CIRCUIT TRADER</text>
  <rect x="${W - PAD - 286}" y="50" width="286" height="40" rx="20" fill="none" stroke="${LIME}" stroke-opacity="0.5"/>
  <text x="${W - PAD - 143}" y="76" text-anchor="middle" font-family="${MONO}" font-size="16" letter-spacing="3" fill="${LIME}">SURVIVAL IS THE EDGE</text>

  <text x="${PAD}" y="150" font-family="${SANS}" font-size="25" fill="${MUTED}">An autonomous BNB-chain trading agent that <tspan fill="${TEXT}" font-weight="600">cannot trade unless its signed constitution allows it.</tspan></text>
  <text x="${PAD}" y="184" font-family="${MONO}" font-size="15" letter-spacing="1" fill="${DIM}">THE LIVE DECISION PIPELINE</text>

  <!-- pipeline -->
  ${card(x1, cy0, cw, ch, "01 · DATA", "THE EYES", "CMC Agent Hub", LIME, [
    "Live price + indicator signals",
    "pulled over MCP each tick.",
    "",
    "› trend · momentum · volume",
    "› token risk lookups",
  ])}
  ${chev(x1 + cw + gap / 2, cy0 + ch / 2)}
  ${card(x2, cy0, cw, ch, "02 · GOVERNANCE", "THE BRAIN", "The Constitution", "#9b8bff", [
    "A signed risk rulebook the agent",
    "enforces on every single order:",
  ])}
  <g font-family="${MONO}" font-size="16" font-weight="700">
    <rect x="${x2 + 28}" y="${cy0 + 244}" width="92" height="34" rx="6" fill="${ALLOW}" fill-opacity="0.16" stroke="${ALLOW}" stroke-opacity="0.5"/>
    <text x="${x2 + 74}" y="${cy0 + 266}" text-anchor="middle" fill="${ALLOW}">ALLOW</text>
    <rect x="${x2 + 132}" y="${cy0 + 244}" width="92" height="34" rx="6" fill="${CLAMP}" fill-opacity="0.16" stroke="${CLAMP}" stroke-opacity="0.5"/>
    <text x="${x2 + 178}" y="${cy0 + 266}" text-anchor="middle" fill="${CLAMP}">CLAMP</text>
    <rect x="${x2 + 236}" y="${cy0 + 244}" width="92" height="34" rx="6" fill="${DENY}" fill-opacity="0.16" stroke="${DENY}" stroke-opacity="0.5"/>
    <text x="${x2 + 282}" y="${cy0 + 266}" text-anchor="middle" fill="${DENY}">DENY</text>
  </g>
  <text x="${x2 + 28}" y="${cy0 + 318}" font-family="${MONO}" font-size="16" fill="${MUTED}">No signal → no trade.</text>
  ${chev(x2 + cw + gap / 2, cy0 + ch / 2)}
  ${card(x3, cy0, cw, ch, "03 · EXECUTION", "THE HANDS", "BNB Chain", ALLOW, [
    "Approved orders settle on-chain",
    "via Trust Wallet Agent Kit.",
    "",
    "› real swaps, real tx hashes",
    "› reserve always protected",
  ])}

  <!-- verdict strip (mimics the live dashboard timeline row) -->
  <rect x="${PAD}" y="${verdictY}" width="${W - 2 * PAD}" height="86" rx="14" fill="${SURF2}" stroke="${BORDER}"/>
  <rect x="${PAD + 22}" y="${verdictY + 26}" width="118" height="34" rx="6" fill="${ALLOW}" fill-opacity="0.18" stroke="${ALLOW}" stroke-opacity="0.6"/>
  <text x="${PAD + 81}" y="${verdictY + 49}" text-anchor="middle" font-family="${MONO}" font-size="16" font-weight="700" fill="${ALLOW}">EXECUTED</text>
  <text x="${PAD + 168}" y="${verdictY + 49}" font-family="${MONO}" font-size="19" fill="${TEXT}">BNB</text>
  <text x="${PAD + 240}" y="${verdictY + 49}" font-family="${MONO}" font-size="19" fill="${MUTED}">buy 0.20 USD</text>
  <text x="${PAD + 470}" y="${verdictY + 49}" font-family="${MONO}" font-size="19" fill="${DIM}">tx 0x4c38d9…c727c5</text>
  <text x="${W - PAD - 22}" y="${verdictY + 49}" text-anchor="end" font-family="${MONO}" font-size="16" fill="${LIME}">● constitution enforced</text>

  <!-- footer -->
  <text x="${PAD}" y="${H - 44}" font-family="${MONO}" font-size="22" font-weight="700" fill="${LIME}">#CMCAgentHub<tspan fill="${MUTED}" font-weight="400">  ·  </tspan><tspan fill="${TEXT}">@CoinMarketCap</tspan><tspan fill="${MUTED}" font-weight="400">  ·  </tspan><tspan fill="${TEXT}">#BNBHack</tspan></text>
  <text x="${W - PAD}" y="${H - 44}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${MUTED}">circuit-trader.vercel.app</text>
</svg>`;

// Output lands next to this script, inside marketing/.
const outDir = new URL(".", import.meta.url).pathname;
await writeFile(`${outDir}cmc-agent-hub.svg`, svg);
await sharp(Buffer.from(svg)).png().toFile(`${outDir}cmc-agent-hub.png`);
const meta = await sharp(`${outDir}cmc-agent-hub.png`).metadata();
console.log("written", meta.width + "x" + meta.height);
