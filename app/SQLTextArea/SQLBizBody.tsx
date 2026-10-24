import { ArrowDownWideNarrow, Columns3, Database, Filter, GitMerge, Layers, ListFilter, Sigma } from "lucide-react";
import { getSQLBizSummary } from "./sqlBizSummary";

const icons = {
  Read: Database,
  Join: GitMerge,
  Filter,
  Aggregate: Sigma,
  Select: Columns3,
  Sort: ArrowDownWideNarrow,
  Limit: ListFilter,
  Skip: ListFilter,
  Prepare: Layers,
  Window: Layers,
  Deduplicate: Layers,
  "Filter groups": Filter,
  "Filter window": Filter,
};

export function SQLBizBody({ text }: { text: string }) {
  const summary = getSQLBizSummary(text);
  return (
    <div
      aria-label="Query overview"
      style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px", background: "#fffef5" }}
      onWheel={(event) => event.stopPropagation()}
    >
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {summary.steps.map((step, index) => {
          const Icon = icons[step.label as keyof typeof icons] ?? Layers;
          return (
            <li key={index} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span
                style={{
                  display: "flex",
                  padding: 5,
                  border: "2px solid #000",
                  borderRadius: 6,
                  background: "#fef08a",
                  flexShrink: 0,
                }}
              >
                <Icon size={16} aria-hidden />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 800 }}>{step.label}</div>
                <div style={{ fontSize: 12, lineHeight: "17px", overflowWrap: "anywhere", color: "#444" }}>
                  {step.detail}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {summary.note && (
        <p style={{ fontSize: 12, lineHeight: "17px", color: "#666", margin: "10px 0 0" }}>{summary.note}</p>
      )}
    </div>
  );
}
