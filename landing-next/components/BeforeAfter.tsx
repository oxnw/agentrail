'use client';

// True 30° isometric architecture diagram — ported from Claude Design handoff.
// Two panels: Before (N×M chaos beziers) + After (clean rail connections).

const ISO_X = Math.cos(Math.PI / 6); // 0.866
const ISO_Y = Math.sin(Math.PI / 6); // 0.5

function isoProject(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * ISO_X, (x + y) * ISO_Y - z];
}

type Pt = [number, number];

function boxVerts(ox: number, oy: number, w: number, d: number, h: number, unit: number) {
  const pt = (x: number, y: number, z: number): Pt => {
    const [sx, sy] = isoProject(x, y, z);
    return [ox + sx * unit, oy + sy * unit];
  };
  return {
    bfl: pt(0, 0, 0), bfr: pt(w, 0, 0), bbr: pt(w, d, 0), bbl: pt(0, d, 0),
    tfl: pt(0, 0, h), tfr: pt(w, 0, h), tbr: pt(w, d, h), tbl: pt(0, d, h),
    topCenter: pt(w / 2, d / 2, h),
  };
}

const polyStr = (pts: Pt[]) =>
  pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');

// ── IsoBox ──────────────────────────────────────────────────────────────────
interface IsoBoxProps {
  ox: number; oy: number; w: number; d: number; h: number; unit: number;
  topFill: string; rightFill: string; leftFill: string;
  stroke?: string; strokeWidth?: number;
  topAccent?: { color: string };
  topAccentDepth?: number;
  shadow?: boolean;
  children?: (v: ReturnType<typeof boxVerts>) => React.ReactNode;
}

function IsoBox({
  ox, oy, w, d, h, unit,
  topFill, rightFill, leftFill,
  stroke = '#0c1420', strokeWidth = 0.6,
  topAccent, topAccentDepth = 0.16,
  shadow = true,
  children,
}: IsoBoxProps) {
  const v = boxVerts(ox, oy, w, d, h, unit);

  const shadowPoly = polyStr([
    [v.bfl[0], v.bfl[1] + 1.5],
    [v.bfr[0] + 2, v.bfr[1] + 1.5],
    [v.bbr[0], v.bbr[1] + 1.5],
    [v.bbl[0] - 2, v.bbl[1] + 1.5],
  ]);

  let accentPoly: string | null = null;
  if (topAccent) {
    const a1 = v.tfl, a2 = v.tfr;
    const a3: Pt = [v.tfr[0] + (v.tbr[0] - v.tfr[0]) * topAccentDepth, v.tfr[1] + (v.tbr[1] - v.tfr[1]) * topAccentDepth];
    const a4: Pt = [v.tfl[0] + (v.tbl[0] - v.tfl[0]) * topAccentDepth, v.tfl[1] + (v.tbl[1] - v.tfl[1]) * topAccentDepth];
    accentPoly = polyStr([a1, a2, a3, a4]);
  }

  return (
    <g>
      {shadow && <polygon points={shadowPoly} fill="rgba(12,20,32,0.18)" filter="url(#softBlur)" opacity={0.7} />}
      <polygon points={polyStr([v.bfl, v.bfr, v.tfr, v.tfl])} fill={rightFill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <polygon points={polyStr([v.bfl, v.bbl, v.tbl, v.tfl])} fill={leftFill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <polygon points={polyStr([v.tfl, v.tfr, v.tbr, v.tbl])} fill={topFill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {accentPoly && <polygon points={accentPoly} fill={topAccent!.color} />}
      {children?.(v)}
    </g>
  );
}

// ── AgentNode ────────────────────────────────────────────────────────────────
function AgentNode({ ox, oy, label, unit }: { ox: number; oy: number; label: string; unit: number }) {
  const w = 2.4, d = 1.7, h = 1.9;
  const v = boxVerts(ox, oy, w, d, h, unit);

  const pillTL: Pt = [v.tfl[0] + (v.tfr[0]-v.tfl[0])*0.12 + (v.tbl[0]-v.tfl[0])*0.32, v.tfl[1] + (v.tfr[1]-v.tfl[1])*0.12 + (v.tbl[1]-v.tfl[1])*0.32];
  const pillTR: Pt = [v.tfl[0] + (v.tfr[0]-v.tfl[0])*0.88 + (v.tbl[0]-v.tfl[0])*0.32, v.tfl[1] + (v.tfr[1]-v.tfl[1])*0.88 + (v.tbl[1]-v.tfl[1])*0.32];
  const pillBR: Pt = [v.tfl[0] + (v.tfr[0]-v.tfl[0])*0.88 + (v.tbl[0]-v.tfl[0])*0.60, v.tfl[1] + (v.tfr[1]-v.tfl[1])*0.88 + (v.tbl[1]-v.tfl[1])*0.60];
  const pillBL: Pt = [v.tfl[0] + (v.tfr[0]-v.tfl[0])*0.12 + (v.tbl[0]-v.tfl[0])*0.60, v.tfl[1] + (v.tfr[1]-v.tfl[1])*0.12 + (v.tbl[1]-v.tfl[1])*0.60];

  const dotRow: Pt[] = [];
  for (let i = 0; i < 3; i++) {
    const t = 0.18 + i * 0.18;
    dotRow.push([
      v.bfl[0] + (v.bfr[0]-v.bfl[0])*t + (v.tfl[0]-v.bfl[0])*0.18,
      v.bfl[1] + (v.bfr[1]-v.bfl[1])*t + (v.tfl[1]-v.bfl[1])*0.18,
    ]);
  }

  const labelX = (pillTL[0] + pillBR[0]) / 2;
  const labelY = (pillTL[1] + pillBR[1]) / 2;
  const ux = v.tfr[0]-v.tfl[0], uy = v.tfr[1]-v.tfl[1];
  const vvx = v.tbl[0]-v.tfl[0], vvy = v.tbl[1]-v.tfl[1];
  const ulen = Math.hypot(ux, uy) || 1, vlen = Math.hypot(vvx, vvy) || 1;
  const skew = `matrix(${(ux/ulen*0.85).toFixed(4)},${(uy/ulen*0.85).toFixed(4)},${(vvx/vlen*0.85).toFixed(4)},${(vvy/vlen*0.85).toFixed(4)},${labelX.toFixed(2)},${labelY.toFixed(2)})`;

  return (
    <IsoBox ox={ox} oy={oy} w={w} d={d} h={h} unit={unit}
      topFill="#15212f" rightFill="#0c1420" leftFill="#0a121e"
      stroke="#1e3a54" strokeWidth={0.7}
      topAccent={{ color: '#00875a' }} topAccentDepth={0.17}
    >
      {(vv) => (
        <g>
          <polygon points={polyStr([vv.tfl, vv.tfr, [vv.tfr[0]+(vv.tbr[0]-vv.tfr[0])*0.06, vv.tfr[1]+(vv.tbr[1]-vv.tfr[1])*0.06], [vv.tfl[0]+(vv.tbl[0]-vv.tfl[0])*0.06, vv.tfl[1]+(vv.tbl[1]-vv.tfl[1])*0.06]])} fill="#1eb37e" opacity={0.35} />
          <polygon points={polyStr([pillTL, pillTR, pillBR, pillBL])} fill="#0a121e" stroke="#1e3a54" strokeWidth={0.5} />
          <text transform={skew} x={0} y={0} textAnchor="middle" dominantBaseline="middle" fill="#5a9cb8" fontFamily="JetBrains Mono, monospace" fontSize="9.5" fontWeight="500" letterSpacing="0.06em">{label}</text>
          {dotRow.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={1.6}
              fill={i === 0 ? '#00875a' : i === 1 ? '#5a9cb8' : '#1e3a54'}
              opacity={i === 0 ? 1 : i === 1 ? 0.85 : 0.6}
            />
          ))}
          <line
            x1={v.bfl[0]+(v.bfr[0]-v.bfl[0])*0.16+(v.tfl[0]-v.bfl[0])*0.78}
            y1={v.bfl[1]+(v.bfr[1]-v.bfl[1])*0.16+(v.tfl[1]-v.bfl[1])*0.78}
            x2={v.bfl[0]+(v.bfr[0]-v.bfl[0])*0.84+(v.tfl[0]-v.bfl[0])*0.78}
            y2={v.bfl[1]+(v.bfr[1]-v.bfl[1])*0.84+(v.tfl[1]-v.bfl[1])*0.78}
            stroke="#1e3a54" strokeWidth={1}
          />
        </g>
      )}
    </IsoBox>
  );
}

// ── ToolNode ─────────────────────────────────────────────────────────────────
function ToolNode({ ox, oy, brandColor, name, unit }: { ox: number; oy: number; brandColor: string; name: string; unit: number }) {
  const w = 2.6, d = 1.9, h = 1.4;
  const v = boxVerts(ox, oy, w, d, h, unit);

  const dotPos: Pt = [v.tfl[0]+(v.tfr[0]-v.tfl[0])*0.18+(v.tbl[0]-v.tfl[0])*0.42, v.tfl[1]+(v.tfr[1]-v.tfl[1])*0.18+(v.tbl[1]-v.tfl[1])*0.42];
  const labelPos: Pt = [v.tfl[0]+(v.tfr[0]-v.tfl[0])*0.36+(v.tbl[0]-v.tfl[0])*0.42, v.tfl[1]+(v.tfr[1]-v.tfl[1])*0.36+(v.tbl[1]-v.tfl[1])*0.42];

  const ux = v.tfr[0]-v.tfl[0], uy = v.tfr[1]-v.tfl[1];
  const vvx = v.tbl[0]-v.tfl[0], vvy = v.tbl[1]-v.tfl[1];
  const ulen = Math.hypot(ux, uy) || 1, vlen = Math.hypot(vvx, vvy) || 1;
  const skew = `matrix(${(ux/ulen*0.9).toFixed(4)},${(uy/ulen*0.9).toFixed(4)},${(vvx/vlen*0.9).toFixed(4)},${(vvy/vlen*0.9).toFixed(4)},${labelPos[0].toFixed(2)},${labelPos[1].toFixed(2)})`;

  return (
    <IsoBox ox={ox} oy={oy} w={w} d={d} h={h} unit={unit}
      topFill="#ffffff" rightFill="#eef2f6" leftFill="#dfe5ec"
      stroke="#c4ccd6" strokeWidth={0.7}
    >
      {(vv) => (
        <g>
          <polygon points={polyStr([vv.tfl, vv.tfr, [vv.tfr[0]+(vv.tbr[0]-vv.tfr[0])*0.22, vv.tfr[1]+(vv.tbr[1]-vv.tfr[1])*0.22], [vv.tfl[0]+(vv.tbl[0]-vv.tfl[0])*0.22, vv.tfl[1]+(vv.tbl[1]-vv.tfl[1])*0.22]])} fill="#f4f7fa" stroke="#dfe5ec" strokeWidth={0.4} />
          <circle cx={dotPos[0]} cy={dotPos[1]} r={3.4} fill={brandColor} />
          <circle cx={dotPos[0]} cy={dotPos[1]} r={5.2} fill="none" stroke={brandColor} strokeOpacity={0.25} strokeWidth={1} />
          <text transform={skew} x={0} y={0} textAnchor="start" dominantBaseline="middle" fill="#0c1420" fontFamily="Space Grotesk, sans-serif" fontSize="10" fontWeight="600">{name}</text>
          {[0.46, 0.6, 0.74].map((t, i) => {
            const sx = vv.tfl[0]+(vv.tfr[0]-vv.tfl[0])*0.16+(vv.tbl[0]-vv.tfl[0])*t;
            const sy = vv.tfl[1]+(vv.tfr[1]-vv.tfl[1])*0.16+(vv.tbl[1]-vv.tfl[1])*t;
            const ex = vv.tfl[0]+(vv.tfr[0]-vv.tfl[0])*(0.48+i*0.14)+(vv.tbl[0]-vv.tfl[0])*t;
            const ey = vv.tfl[1]+(vv.tfr[1]-vv.tfl[1])*(0.48+i*0.14)+(vv.tbl[1]-vv.tfl[1])*t;
            return <line key={i} x1={sx} y1={sy} x2={ex} y2={ey} stroke="#c4ccd6" strokeWidth={1.1} strokeLinecap="round" />;
          })}
        </g>
      )}
    </IsoBox>
  );
}

// ── AgentRailBar ─────────────────────────────────────────────────────────────
function AgentRailBar({ ox, oy, length, depth, height, unit, animate }: { ox: number; oy: number; length: number; depth: number; height: number; unit: number; animate: boolean }) {
  const w = length, d = depth, h = height;
  const v = boxVerts(ox, oy, w, d, h, unit);

  const lines: { sx: number; sy: number; ex: number; ey: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const t = 0.3 + i * 0.18;
    lines.push({
      sx: v.tfl[0]+(v.tbl[0]-v.tfl[0])*t+(v.tfr[0]-v.tfl[0])*0.04,
      sy: v.tfl[1]+(v.tbl[1]-v.tfl[1])*t+(v.tfr[1]-v.tfl[1])*0.04,
      ex: v.tfl[0]+(v.tbl[0]-v.tfl[0])*t+(v.tfr[0]-v.tfl[0])*0.96,
      ey: v.tfl[1]+(v.tbl[1]-v.tfl[1])*t+(v.tfr[1]-v.tfl[1])*0.96,
    });
  }

  const ticks: { px: number; py: number; ex: number; ey: number; major: boolean }[] = [];
  for (let i = 0; i <= 13; i++) {
    const t = i / 13;
    const px = v.tfl[0]+(v.tfr[0]-v.tfl[0])*t, py = v.tfl[1]+(v.tfr[1]-v.tfl[1])*t;
    ticks.push({ px, py, ex: px+(v.tbl[0]-v.tfl[0])*0.06, ey: py+(v.tbl[1]-v.tfl[1])*0.06, major: i%4===0 });
  }

  const labelPos: Pt = [v.tfl[0]+(v.tfr[0]-v.tfl[0])*0.5+(v.tbl[0]-v.tfl[0])*0.5, v.tfl[1]+(v.tfr[1]-v.tfl[1])*0.5+(v.tbl[1]-v.tfl[1])*0.5];
  const ux = v.tfr[0]-v.tfl[0], uy = v.tfr[1]-v.tfl[1];
  const vvx = v.tbl[0]-v.tfl[0], vvy = v.tbl[1]-v.tfl[1];
  const ulen = Math.hypot(ux, uy)||1, vlen = Math.hypot(vvx,vvy)||1;
  const skew = `matrix(${(ux/ulen).toFixed(4)},${(uy/ulen).toFixed(4)},${(vvx/vlen).toFixed(4)},${(vvy/vlen).toFixed(4)},${labelPos[0].toFixed(2)},${labelPos[1].toFixed(2)})`;

  return (
    <g>
      <ellipse cx={(v.bfl[0]+v.bbr[0])/2} cy={(v.bfl[1]+v.bbr[1])/2+6}
        rx={Math.abs(v.bfr[0]-v.bbl[0])/2+24} ry={Math.abs(v.bbr[1]-v.bfl[1])/2+6}
        fill="url(#railUnderglow)" opacity={0.85}
      />
      <polygon points={polyStr([v.tfl, v.tfr, v.tbr, v.tbl])} fill="#1eb37e" opacity={0.5} filter="url(#emeraldGlow)" />
      <IsoBox ox={ox} oy={oy} w={w} d={d} h={h} unit={unit}
        topFill="#00875a" rightFill="#006b48" leftFill="#005238"
        stroke="#003e2c" strokeWidth={0.8} shadow={false}
      >
        {(vv) => (
          <g>
            <line x1={vv.tfl[0]} y1={vv.tfl[1]} x2={vv.tfr[0]} y2={vv.tfr[1]} stroke="#7be0b6" strokeWidth={1.4} strokeLinecap="round" opacity={0.85} />
            <line x1={vv.tfl[0]} y1={vv.tfl[1]} x2={vv.tbl[0]} y2={vv.tbl[1]} stroke="#7be0b6" strokeWidth={1.1} strokeLinecap="round" opacity={0.55} />
            {lines.map((ln, i) => (
              <line key={i} x1={ln.sx} y1={ln.sy} x2={ln.ex} y2={ln.ey}
                stroke={i===1 ? '#a4ecca' : '#48c894'} strokeWidth={i===1 ? 1.4 : 1}
                strokeLinecap="round" opacity={i===1 ? 0.95 : 0.7}
                strokeDasharray={i===1 ? '0' : '1.5 4'}
              >
                {animate && i===1 && <animate attributeName="stroke-dashoffset" from="0" to="-40" dur="2.5s" repeatCount="indefinite" />}
              </line>
            ))}
            {ticks.map((t, i) => <line key={i} x1={t.px} y1={t.py} x2={t.ex} y2={t.ey} stroke={t.major ? '#a4ecca' : '#48c894'} strokeWidth={t.major ? 1 : 0.6} opacity={t.major ? 0.95 : 0.7} />)}
            <line
              x1={vv.tfl[0]+(vv.tfr[0]-vv.tfl[0])*0.08+(vv.tbl[0]-vv.tfl[0])*0.5}
              y1={vv.tfl[1]+(vv.tfr[1]-vv.tfl[1])*0.08+(vv.tbl[1]-vv.tfl[1])*0.5}
              x2={vv.tfl[0]+(vv.tfr[0]-vv.tfl[0])*0.92+(vv.tbl[0]-vv.tfl[0])*0.5}
              y2={vv.tfl[1]+(vv.tfr[1]-vv.tfl[1])*0.92+(vv.tbl[1]-vv.tfl[1])*0.5}
              stroke="url(#railPulse)" strokeWidth={2.6} strokeLinecap="round" opacity={0.9}
            >
              {animate && <animate attributeName="opacity" values="0.5;1;0.5" dur="2.4s" repeatCount="indefinite" />}
            </line>
            <text transform={skew} x={0} y={-3} textAnchor="middle" dominantBaseline="middle" fill="#03261b" fontFamily="Space Grotesk, sans-serif" fontSize="10" fontWeight="700" letterSpacing="0.32em">AGENTRAIL</text>
            <text transform={skew} x={0} y={8} textAnchor="middle" dominantBaseline="middle" fill="#03261b" fontFamily="JetBrains Mono, monospace" fontSize="6" fontWeight="500" letterSpacing="0.18em" opacity={0.75}>CONTROL · PLANE · v1</text>
          </g>
        )}
      </IsoBox>
    </g>
  );
}

// ── ChaosLine ────────────────────────────────────────────────────────────────
function ChaosLine({ from, to, seed = 0, animate, intensity = 1 }: { from: Pt; to: Pt; seed?: number; animate: boolean; intensity?: number }) {
  const r = (s: number) => { const x = Math.sin(s*12.9898)*43758.5453; return x - Math.floor(x); };
  const dx = to[0]-from[0], dy = to[1]-from[1];
  const c1: Pt = [from[0]+dx*0.25+(r(seed+1)-0.5)*220*intensity, from[1]+dy*0.25+(r(seed+2)-0.5)*80*intensity];
  const c2: Pt = [from[0]+dx*0.75+(r(seed+3)-0.5)*220*intensity, from[1]+dy*0.75+(r(seed+4)-0.5)*80*intensity];
  const path = `M ${from[0]} ${from[1]} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to[0]} ${to[1]}`;
  const a = Math.atan2(to[1]-c2[1], to[0]-c2[0]);
  const sz = 5;
  const arrowPts = polyStr([to, [to[0]-Math.cos(a-0.5)*sz, to[1]-Math.sin(a-0.5)*sz], [to[0]-Math.cos(a+0.5)*sz, to[1]-Math.sin(a+0.5)*sz]]);

  return (
    <g>
      <path d={path} fill="none" stroke="#e8741f" strokeOpacity={0.18} strokeWidth={5} strokeLinecap="round" filter="url(#orangeGlow)" />
      <path d={path} fill="none" stroke="#e8741f" strokeWidth={1.6} strokeDasharray="4 4" strokeLinecap="round">
        {animate && <animate attributeName="stroke-dashoffset" from="0" to="-160" dur={`${3+r(seed)*2}s`} repeatCount="indefinite" />}
      </path>
      <polygon points={arrowPts} fill="#e8741f" />
    </g>
  );
}

// ── RailLine ─────────────────────────────────────────────────────────────────
function RailLine({ from, to, animate, viaY }: { from: Pt; to: Pt; animate: boolean; viaY?: number }) {
  let path: string;
  if (viaY != null) {
    const c1: Pt = [from[0], from[1]+(viaY-from[1])*0.55];
    const c2: Pt = [to[0], viaY+(to[1]-viaY)*0.45];
    path = `M ${from[0]} ${from[1]} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to[0]} ${to[1]}`;
  } else {
    const my = (from[1]+to[1])/2;
    path = `M ${from[0]} ${from[1]} C ${from[0]} ${my} ${to[0]} ${my} ${to[0]} ${to[1]}`;
  }
  const a = Math.atan2(to[1]-(to[1]-12), 0);
  const sz = 4.5;
  const ref: Pt = [to[0], to[1]-12];
  const da = Math.atan2(to[1]-ref[1], to[0]-ref[0]);
  const arrowPts = polyStr([to, [to[0]-Math.cos(da-0.5)*sz, to[1]-Math.sin(da-0.5)*sz], [to[0]-Math.cos(da+0.5)*sz, to[1]-Math.sin(da+0.5)*sz]]);

  return (
    <g>
      <path d={path} fill="none" stroke="#00875a" strokeOpacity={0.22} strokeWidth={4.5} strokeLinecap="round" filter="url(#emeraldGlow)" />
      <path d={path} fill="none" stroke="#00875a" strokeWidth={1.5} strokeLinecap="round" />
      {animate && (
        <circle r="2.4" fill="#00875a">
          <animateMotion dur="2.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      <polygon points={arrowPts} fill="#00875a" />
    </g>
  );
}

// ── SVG Defs ─────────────────────────────────────────────────────────────────
function PanelDefs() {
  return (
    <defs>
      <filter id="softBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" /></filter>
      <filter id="emeraldGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6" /></filter>
      <filter id="orangeGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.5" /></filter>
      <radialGradient id="railUnderglow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#1eb37e" stopOpacity="0.55" />
        <stop offset="60%" stopColor="#1eb37e" stopOpacity="0.18" />
        <stop offset="100%" stopColor="#1eb37e" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="railPulse" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#a4ecca" stopOpacity="0.1" />
        <stop offset="50%" stopColor="#ffffff" stopOpacity="1" />
        <stop offset="100%" stopColor="#a4ecca" stopOpacity="0.1" />
      </linearGradient>
      <linearGradient id="groundFade" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#e6ebf0" stopOpacity="0" />
        <stop offset="100%" stopColor="#e6ebf0" stopOpacity="0.7" />
      </linearGradient>
    </defs>
  );
}

// ── Ground Tiles ──────────────────────────────────────────────────────────────
function GroundTiles({ cx, cy, unit, extentX, extentY, accent }: { cx: number; cy: number; unit: number; extentX: number; extentY: number; accent?: string }) {
  const tiles = [];
  for (let xi = -extentX; xi <= extentX; xi++) {
    const [sx1,sy1] = isoProject(xi,-extentY,0), [sx2,sy2] = isoProject(xi,extentY,0);
    tiles.push(<line key={`vx${xi}`} x1={cx+sx1*unit} y1={cy+sy1*unit} x2={cx+sx2*unit} y2={cy+sy2*unit} stroke="#0c1420" strokeOpacity={xi===0?0.12:0.05} strokeWidth={xi===0?0.6:0.4} />);
  }
  for (let yi = -extentY; yi <= extentY; yi++) {
    const [sx1,sy1] = isoProject(-extentX,yi,0), [sx2,sy2] = isoProject(extentX,yi,0);
    tiles.push(<line key={`hy${yi}`} x1={cx+sx1*unit} y1={cy+sy1*unit} x2={cx+sx2*unit} y2={cy+sy2*unit} stroke="#0c1420" strokeOpacity={yi===0?0.12:0.05} strokeWidth={yi===0?0.6:0.4} />);
  }
  return (
    <g>
      {accent && (() => { const [acx,acy]=isoProject(0,0,0); return <ellipse cx={cx+acx*unit} cy={cy+acy*unit+4} rx={extentX*unit*0.95} ry={extentX*unit*0.95*0.5} fill="none" stroke={accent} strokeOpacity={0.18} strokeWidth={0.8} strokeDasharray="2 6" />; })()}
      {tiles}
      <rect x="0" y="500" width="720" height="120" fill="url(#groundFade)" />
    </g>
  );
}

// ── Row layout helper ─────────────────────────────────────────────────────────
function rowPositions(cx: number, cy: number, count: number, spacing: number, yWorld: number, unit: number): Pt[] {
  const totalSpan = (count-1)*spacing;
  const startX = -totalSpan/2;
  return Array.from({ length: count }, (_, i) => {
    const [sx,sy] = isoProject(startX+i*spacing, yWorld, 0);
    return [cx+sx*unit, cy+sy*unit] as Pt;
  });
}

// ── Before Panel ──────────────────────────────────────────────────────────────
const BEFORE_TOOLS = [
  { color: '#4a576b', name: 'vcs' },
  { color: '#6b574a', name: 'ci' },
  { color: '#4a6b57', name: 'issues' },
  { color: '#574a6b', name: 'deploy' },
];

function BeforePanel({ unit = 22, animate = true, chaosIntensity = 0.5 }: { unit?: number; animate?: boolean; chaosIntensity?: number }) {
  const cx = 360, cy = 360;
  const agentRow = rowPositions(cx, cy, 5, 3.4, -2.6, unit);
  const toolRow = rowPositions(cx, cy, 4, 3.6, 2.6, unit);
  const agentTops = agentRow.map(([ox,oy]) => boxVerts(ox,oy,2.4,1.7,1.9,unit).topCenter);
  const toolTops = toolRow.map(([ox,oy]) => boxVerts(ox,oy,2.6,1.9,1.4,unit).topCenter);

  return (
    <svg viewBox="0 0 720 620" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', width: '100%' }}>
      <PanelDefs />
      <GroundTiles cx={cx} cy={cy} unit={unit} extentX={9} extentY={4.5} />
      {agentRow.map(([ox,oy],i) => <AgentNode key={i} ox={ox} oy={oy} unit={unit} label={`agt_${i+1}`} />)}
      <g>
        {agentTops.map((a,ai) => toolTops.map((t,ti) => (
          <ChaosLine key={`${ai}-${ti}`} from={a} to={t} seed={ai*7+ti*13+1} animate={animate} intensity={chaosIntensity} />
        )))}
      </g>
      {toolRow.map(([ox,oy],i) => <ToolNode key={i} ox={ox} oy={oy} unit={unit} brandColor={BEFORE_TOOLS[i].color} name={BEFORE_TOOLS[i].name} />)}
    </svg>
  );
}

// ── After Panel ───────────────────────────────────────────────────────────────
const AFTER_TOOLS = [
  { color: '#4a576b', name: 'vcs' },
  { color: '#6b574a', name: 'ci' },
  { color: '#4a6b57', name: 'issues' },
  { color: '#574a6b', name: 'deploy' },
];

function AfterPanel({ unit = 22, animate = true }: { unit?: number; animate?: boolean }) {
  const cx = 360, cy = 360;
  const agentRow = rowPositions(cx, cy, 5, 3.4, -2.6, unit);
  const toolRow = rowPositions(cx, cy, 4, 3.6, 2.6, unit);

  const railLen = 17.5, railDepth = 1.0, railHeight = 0.6;
  const [rsx,rsy] = isoProject(-railLen/2, -railDepth/2, 0);
  const railOX = cx+rsx*unit, railOY = cy+rsy*unit;

  const agentTops = agentRow.map(([ox,oy]) => boxVerts(ox,oy,2.4,1.7,1.9,unit).topCenter);
  const toolTops = toolRow.map(([ox,oy]) => boxVerts(ox,oy,2.6,1.9,1.4,unit).topCenter);

  function railTopAt(xWorld: number, yOff = 0): Pt {
    const [sx,sy] = isoProject(xWorld, yOff, railHeight);
    return [cx+sx*unit, cy+sy*unit];
  }

  const agentWorldX = Array.from({length:5},(_,i) => -((4)*3.4)/2 + i*3.4);
  const toolWorldX = Array.from({length:4},(_,i) => -((3)*3.6)/2 + i*3.6);
  const railEntriesAgents = agentWorldX.map(x => railTopAt(x, -0.05));
  const railEntriesTools = toolWorldX.map(x => railTopAt(x, 0.05));

  return (
    <svg viewBox="0 0 720 620" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', width: '100%' }}>
      <PanelDefs />
      <GroundTiles cx={cx} cy={cy} unit={unit} extentX={9} extentY={4.5} accent="#00875a" />
      {agentRow.map(([ox,oy],i) => <AgentNode key={i} ox={ox} oy={oy} unit={unit} label={`agt_${i+1}`} />)}
      <g>{agentTops.map((a,i) => <RailLine key={i} from={a} to={railEntriesAgents[i]} animate={animate} viaY={(a[1]+railEntriesAgents[i][1])/2+6} />)}</g>
      <AgentRailBar ox={railOX} oy={railOY} length={railLen} depth={railDepth} height={railHeight} unit={unit} animate={animate} />
      <g>{toolTops.map((t,i) => <RailLine key={i} from={railEntriesTools[i]} to={t} animate={animate} viaY={(railEntriesTools[i][1]+t[1])/2-8} />)}</g>
      {toolRow.map(([ox,oy],i) => <ToolNode key={i} ox={ox} oy={oy} unit={unit} brandColor={AFTER_TOOLS[i].color} name={AFTER_TOOLS[i].name} />)}
    </svg>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function BeforeAfter() {
  const unit = 22 * 1.3;

  return (
    <section style={{ background: 'var(--bg)', padding: '100px 0 80px', position: 'relative', overflow: 'hidden' }}>
      {/* Blueprint dot + grid background */}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: [
          'radial-gradient(circle, rgba(12,20,32,0.08) 1px, transparent 1.5px)',
          'linear-gradient(rgba(12,20,32,0.04) 1px, transparent 1px)',
          'linear-gradient(90deg, rgba(12,20,32,0.04) 1px, transparent 1px)',
        ].join(','),
        backgroundSize: '24px 24px, 96px 96px, 96px 96px',
      }} />

      <div className="relative max-w-[1540px] mx-auto px-8" style={{ zIndex: 1 }}>
        {/* Heading */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <span style={{ width: '28px', height: '1px', background: 'var(--accent)', display: 'inline-block' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.08em', color: 'var(--accent)' }}>
            03 / Architecture
          </span>
        </div>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 400, fontSize: 'clamp(36px, 4.4vw, 60px)', lineHeight: 1.0, letterSpacing: '-0.025em', margin: '0 0 16px', color: 'var(--ink)' }}>
          Many agents, many tools,{' '}
          <em style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 300, color: 'var(--accent)' }}>one rail</em>.
        </h2>
        <p style={{ fontSize: '17px', color: 'var(--ink-2)', maxWidth: '540px', margin: '0 0 48px' }}>
          N×M bespoke integrations becomes N+M. One connection per agent, one per tool, a shared lifecycle for every ticket.
        </p>

        {/* Two-panel scene — no card, floats on page background */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 0, alignItems: 'stretch' }}>

          {/* Before panel */}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#e8741f', flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#4a576b' }}>Without AgentRail</span>
            </div>
            <div style={{ position: 'relative', width: '100%', aspectRatio: '7/6' }}>
              <BeforePanel unit={unit} animate chaosIntensity={0.5} />
            </div>
            <p style={{ marginTop: '16px', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.04em', color: '#e8741f' }}>
              N × M integrations — grows with every new agent or tool
            </p>
          </div>

          {/* Divider */}
          <div style={{ position: 'relative', width: '1px', background: '#c4ccd6', alignSelf: 'stretch', margin: '40px 32px' }}>
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'var(--bg)', padding: '10px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
              <svg viewBox="0 0 14 14" fill="none" style={{ width: '14px', height: '14px' }}>
                <path d="M2 7h10M8 3l4 4-4 4" stroke="#00875a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>

          {/* After panel */}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#00875a', flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#4a576b' }}>With AgentRail</span>
            </div>
            <div style={{ position: 'relative', width: '100%', aspectRatio: '7/6' }}>
              <AfterPanel unit={unit} animate />
            </div>
            <p style={{ marginTop: '16px', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.04em', color: '#00875a' }}>
              N + M integrations — shared lifecycle, one connection each
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
