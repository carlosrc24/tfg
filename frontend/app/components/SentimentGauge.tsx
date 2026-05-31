"use client";

interface Props {
  sentimentScore: number | null;
  predictionProb: number | null;
}

function Gauge({ value, label, min = -1, max = 1, colorPositive = "#10b981", colorNegative = "#ef4444" }: {
  value: number | null;
  label: string;
  min?: number;
  max?: number;
  colorPositive?: string;
  colorNegative?: string;
}) {
  const normalised = value !== null
    ? Math.max(0, Math.min(1, (value - min) / (max - min)))
    : 0.5;

  const angle = normalised * 180 - 90; // -90° to +90°
  const color = value === null
    ? "#6b7280"
    : value > (min + max) / 2 ? colorPositive : colorNegative;

  const r = 60;
  const cx = 80;
  const cy = 75;

  // Arc path (semi-circle)
  const arcStart = { x: cx - r, y: cy };
  const arcEnd   = { x: cx + r, y: cy };
  const track = `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 0 1 ${arcEnd.x} ${arcEnd.y}`;

  // Filled arc up to normalised value
  const endAngleRad = (normalised * Math.PI);
  const fillEnd = {
    x: cx + r * Math.cos(Math.PI - endAngleRad),
    y: cy - r * Math.sin(endAngleRad),
  };
  const largeArc = normalised > 0.5 ? 1 : 0;
  const fill = `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 ${largeArc} 1 ${fillEnd.x} ${fillEnd.y}`;

  // Needle
  const needleRad = (normalised * Math.PI) - Math.PI / 2;
  const needleLen = 50;
  const needleX = cx + needleLen * Math.cos(needleRad - Math.PI / 2 + Math.PI);
  const needleY = cy + needleLen * Math.sin(needleRad - Math.PI / 2 + Math.PI);

  const displayValue = value !== null ? value.toFixed(3) : "N/A";

  return (
    <div className="flex flex-col items-center">
      <svg width={160} height={100} viewBox="0 0 160 100">
        {/* Background track */}
        <path d={track} fill="none" stroke="#1f2937" strokeWidth={10} strokeLinecap="round" />
        {/* Filled arc */}
        <path d={fill} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round" opacity={0.9} />
        {/* Needle */}
        <line
          x1={cx} y1={cy}
          x2={needleX} y2={needleY}
          stroke="#f9fafb"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={4} fill="#f9fafb" />
        {/* Value */}
        <text x={cx} y={cy + 22} textAnchor="middle" fill={color} fontSize={14} fontWeight="600">
          {displayValue}
        </text>
      </svg>
      <span className="text-xs text-gray-400 mt-1 font-medium">{label}</span>
    </div>
  );
}

export default function SentimentGauge({ sentimentScore, predictionProb }: Props) {
  const sentiment = sentimentScore ?? null;
  const prob = predictionProb !== null && predictionProb !== undefined
    ? predictionProb * 2 - 1   // map [0,1] → [-1,1] for the gauge
    : null;

  const sentimentLabel =
    sentiment === null ? "Sin datos"
    : sentiment >  0.2 ? "Alcista 🟢"
    : sentiment < -0.2 ? "Bajista 🔴"
    : "Neutral ⚪";

  const probLabel =
    predictionProb === null ? "Sin modelo"
    : predictionProb >= 0.6 ? "Comprar 🟢"
    : predictionProb <= 0.4 ? "Vender 🔴"
    : "Mantener ⚪";

  return (
    <div className="glass-card p-6 fade-in">
      <div className="mb-4">
        <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
          Inteligencia de IA
        </span>
        <h2 className="text-lg font-bold text-white mt-1">Sentimiento & Predicción</h2>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col items-center bg-gray-900/50 rounded-xl p-4">
          <Gauge value={sentiment} label="Sentimiento FinBERT" />
          <span className={`text-sm font-semibold mt-2 ${
            sentiment !== null && sentiment > 0.2 ? "text-emerald-400"
            : sentiment !== null && sentiment < -0.2 ? "text-red-400"
            : "text-gray-400"
          }`}>
            {sentimentLabel}
          </span>
        </div>

        <div className="flex flex-col items-center bg-gray-900/50 rounded-xl p-4">
          <Gauge
            value={prob}
            label="P(Subida) LightGBM"
            colorPositive="#10b981"
            colorNegative="#ef4444"
          />
          <span className={`text-sm font-semibold mt-2 ${
            predictionProb !== null && predictionProb >= 0.6 ? "text-emerald-400"
            : predictionProb !== null && predictionProb <= 0.4 ? "text-red-400"
            : "text-gray-400"
          }`}>
            {probLabel}
          </span>
          {predictionProb !== null && (
            <span className="text-xs text-gray-500 mt-1">
              {(predictionProb * 100).toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
