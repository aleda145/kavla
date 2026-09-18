import { BarChart3, FileText, Table2, TriangleAlert } from "lucide-react";
import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { TldrawScrollAreaIndicator } from "../DataSource/TldrawScrollAreaIndicator";
import { useTldrawScrollArea } from "../DataSource/useTldrawScrollArea";
import type { SummaryArtifact, SummaryArtifactKind, SummarySection } from "./summary-shape-types";

const EMPTY_SECTION_TEXT = "No notes captured.";
const SCROLLBAR_HIT_SLOP = 18;

function normalizeSectionTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function findSection(sections: SummarySection[], names: string[]) {
  const normalizedNames = new Set(names.map(normalizeSectionTitle));
  return sections.find((section) => normalizedNames.has(normalizeSectionTitle(section.title))) ?? null;
}

function getExtraSections(sections: SummarySection[]) {
  const fixedNames = new Set([
    "interesting_findings",
    "findings",
    "tidbits",
    "assumptions",
    "data_issues",
    "assumptions_data_issues",
    "assumptions_and_data_issues",
  ]);
  return sections.filter((section) => !fixedNames.has(normalizeSectionTitle(section.title)));
}

function getArtifactIcon(kind: SummaryArtifactKind | string) {
  if (kind === "chart") return BarChart3;
  if (kind === "result") return Table2;
  return FileText;
}

function SectionBlock({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "#111827",
          fontSize: 11,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function TextBox({ children, emphasis = false }: { children: ReactNode; emphasis?: boolean }) {
  return (
    <div
      style={{
        border: "2px solid #000",
        borderRadius: 6,
        backgroundColor: emphasis ? "#ecfdf5" : "#fff",
        padding: "9px 10px",
        fontSize: emphasis ? 15 : 13,
        fontWeight: emphasis ? 800 : 600,
        lineHeight: 1.45,
        color: "#111827",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
      }}
    >
      {children}
    </div>
  );
}

interface SummaryArtifactsProps {
  artifacts: SummaryArtifact[];
  onNavigateToArtifact: (artifact: SummaryArtifact) => void;
}

function SummaryArtifacts({ artifacts, onNavigateToArtifact }: SummaryArtifactsProps) {
  if (artifacts.length === 0) {
    return <TextBox>No chart or result was singled out.</TextBox>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
      {artifacts.map((artifact) => {
        const Icon = getArtifactIcon(artifact.kind);
        return (
          <button
            key={`${artifact.shapeId}:${artifact.title}`}
            title="Jump to original canvas artifact"
            onClick={(event) => {
              event.stopPropagation();
              onNavigateToArtifact(artifact);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              display: "flex",
              gap: 10,
              width: "100%",
              textAlign: "left",
              border: "2px solid #000",
              borderRadius: 6,
              backgroundColor: "#f9fafb",
              padding: 10,
              cursor: "pointer",
              boxShadow: "2px 2px 0px 0px rgba(0,0,0,0.2)",
            }}
          >
            <Icon size={16} strokeWidth={3} color="#111827" style={{ flex: "0 0 auto", marginTop: 2 }} />
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 900,
                  color: "#111827",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {artifact.title || artifact.kind}
              </span>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: 1.35,
                  color: "#374151",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                }}
              >
                {artifact.note || "Relevant supporting artifact."}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface SummaryBodyProps {
  answer: string;
  artifacts: SummaryArtifact[];
  question: string;
  sections: SummarySection[];
  onNavigateToArtifact: (artifact: SummaryArtifact) => void;
}

export function SummaryBody({ answer, artifacts, question, sections, onNavigateToArtifact }: SummaryBodyProps) {
  const scrollArea = useTldrawScrollArea();
  const isScrollbarPointerActive = useRef(false);
  const findings = findSection(sections, ["interesting findings", "findings", "tidbits"]);
  const issues = findSection(sections, [
    "assumptions",
    "data issues",
    "assumptions data issues",
    "assumptions and data issues",
  ]);
  const extraSections = getExtraSections(sections);

  const isPointerOnScrollbar = (event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const bounds = element.getBoundingClientRect();
    const canScrollY = element.scrollHeight > element.clientHeight;
    const canScrollX = element.scrollWidth > element.clientWidth;
    return (
      (canScrollY && event.clientX >= bounds.right - SCROLLBAR_HIT_SLOP) ||
      (canScrollX && event.clientY >= bounds.bottom - SCROLLBAR_HIT_SLOP)
    );
  };

  const onSummaryPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    isScrollbarPointerActive.current = isPointerOnScrollbar(event);
    if (isScrollbarPointerActive.current) {
      scrollArea.onPointerDown(event);
    }
  };

  const onSummaryPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (isScrollbarPointerActive.current) {
      scrollArea.onPointerMove(event);
    }
  };

  const onSummaryPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (isScrollbarPointerActive.current) {
      scrollArea.onPointerUp(event);
      isScrollbarPointerActive.current = false;
    }
  };

  const onSummaryPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (isScrollbarPointerActive.current) {
      scrollArea.onPointerCancel(event);
      isScrollbarPointerActive.current = false;
    }
  };

  return (
    <>
      <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />

      <div
        ref={scrollArea.ref}
        onPointerDown={onSummaryPointerDown}
        onPointerMove={onSummaryPointerMove}
        onPointerUp={onSummaryPointerUp}
        onPointerCancel={onSummaryPointerCancel}
        onWheel={scrollArea.onWheel}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          gap: 14,
          padding: 14,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        <SectionBlock title="Question">
          <TextBox>{question || "No question captured."}</TextBox>
        </SectionBlock>

        <SectionBlock title="Answer">
          <TextBox emphasis>{answer || "No answer captured."}</TextBox>
        </SectionBlock>

        <SectionBlock title="Key artifacts">
          <SummaryArtifacts artifacts={artifacts} onNavigateToArtifact={onNavigateToArtifact} />
        </SectionBlock>

        <SectionBlock title="Interesting findings">
          <TextBox>{findings?.body || EMPTY_SECTION_TEXT}</TextBox>
        </SectionBlock>

        <SectionBlock
          title="Assumptions & data issues"
          icon={<TriangleAlert size={13} strokeWidth={3} color="#111827" />}
        >
          <TextBox>{issues?.body || EMPTY_SECTION_TEXT}</TextBox>
        </SectionBlock>

        {extraSections.map((section) => (
          <SectionBlock key={section.title} title={section.title}>
            <TextBox>{section.body}</TextBox>
          </SectionBlock>
        ))}
      </div>
    </>
  );
}
