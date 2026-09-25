import { Search } from "lucide-react";
import { SourceListView } from "./SourceListView";

export interface DemoFileRecord {
  id: string;
  name: string;
  size: number;
  publicUrl: string;
}

export const demoFiles: DemoFileRecord[] = [
  {
    id: "titanic",
    name: "titanic.parquet",
    size: 40013,
    publicUrl: "https://assets.kavla.dev/demo/titanic.parquet",
  },
  {
    id: "yellow_taxi_2025",
    name: "yellow_taxi_2025-10.parquet",
    size: 75267589,
    publicUrl: "https://assets.kavla.dev/demo/yellow_taxi_2025-10.parquet",
  },
  {
    id: "taxi_zone_lookup",
    name: "taxi_zone_lookup.csv",
    size: 12331,
    publicUrl: "https://assets.kavla.dev/demo/taxi_zone_lookup.csv",
  },
];

export function DemoDatasetBrowser({
  onBack,
  onSelect,
}: {
  onBack: () => void;
  onSelect: (file: DemoFileRecord) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3">
      <SourceListView
        items={demoFiles}
        emptyState={null}
        footer={
          <p className="m-0 rounded border border-black bg-yellow-100 px-2 py-1 text-[11px]">
            Selecting a dataset downloads the entire file and stores it in this document.
          </p>
        }
        headerCountText={`${demoFiles.length} files`}
        headerIcon={<Search size={14} />}
        headerLabel="Demo data"
        headerBackgroundColor="#fff"
        isLoading={false}
        keyForItem={(file) => file.id}
        onBack={onBack}
        renderItem={(file) => (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded border-2 border-transparent p-2 text-left text-xs hover:border-black hover:bg-yellow-50 cursor-pointer"
            onClick={() => onSelect(file)}
            onPointerDown={(event) => event.stopPropagation()}
            title={`Download ${file.name}`}
          >
            <span className="min-w-0 truncate font-bold">{file.name}</span>
            <span className="shrink-0 font-mono">
              {file.size >= 1_000_000
                ? `${(file.size / 1_000_000).toFixed(1)} MB`
                : `${(file.size / 1_000).toFixed(1)} KB`}
            </span>
          </button>
        )}
      />
    </div>
  );
}
