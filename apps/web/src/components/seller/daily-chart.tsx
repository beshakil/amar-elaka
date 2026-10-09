import { localizeDigits } from '@amar-elaka/dynamic-form';
import {
  areaPath,
  labelIndexes,
  linePath,
  niceMax,
  xAt,
  yAt,
  type Plot,
} from '@/lib/seller/charts';

// Presentation: the chart's drawing box and how many day labels fit under it.
const WIDTH = 720;
const HEIGHT = 220;
const PAD = { left: 40, right: 12, top: 12, bottom: 28 };
const LABELS = 7;

/**
 * Views and contacts per day as two lines on one axis (ADR 057), server-
 * rendered SVG that scales to its container. `label` describes it for screen
 * readers; the numbers are also in the tiles above it.
 */
export function DailyChart({
  days,
  label,
  legend,
  formatDay,
}: {
  days: { date: string; views: number; contacts: number }[];
  label: string;
  legend: { views: string; contacts: string };
  formatDay: (iso: string) => string;
}) {
  const plot: Plot = {
    width: WIDTH - PAD.left - PAD.right,
    height: HEIGHT - PAD.top - PAD.bottom,
    top: niceMax(Math.max(0, ...days.map((d) => d.views), ...days.map((d) => d.contacts))),
  };
  const views = days.map((d) => d.views);
  const contacts = days.map((d) => d.contacts);
  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={label}
        className="h-auto w-full"
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {[0, 0.5, 1].map((share) => {
            const y = yAt(plot.top * share, plot);
            return (
              <g key={share}>
                <line
                  x1={0}
                  x2={plot.width}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeDasharray="3 3"
                />
                <text
                  x={-6}
                  y={y}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-[11px]"
                >
                  {localizeDigits(String(plot.top * share), 'bn')}
                </text>
              </g>
            );
          })}
          <path d={areaPath(views, plot)} className="fill-brand/10" />
          <path d={linePath(views, plot)} className="fill-none stroke-brand" strokeWidth={2} />
          <path
            d={linePath(contacts, plot)}
            className="fill-none stroke-amber-500"
            strokeWidth={2}
          />
          {labelIndexes(days.length, LABELS).map((i) => (
            <text
              key={days[i]!.date}
              x={xAt(i, days.length, plot)}
              y={plot.height + 18}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {formatDay(days[i]!.date)}
            </text>
          ))}
        </g>
      </svg>
      <figcaption className="flex gap-4 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-brand" aria-hidden /> {legend.views}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-amber-500" aria-hidden /> {legend.contacts}
        </span>
      </figcaption>
    </figure>
  );
}
