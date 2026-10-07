import { requireHeatmapViewer } from './access';

export default async function HeatmapLayout({ children }: { children: React.ReactNode }) {
  await requireHeatmapViewer();
  return children;
}
