import { siPython } from "simple-icons";

export function PythonIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={siPython.path} /></svg>;
}
