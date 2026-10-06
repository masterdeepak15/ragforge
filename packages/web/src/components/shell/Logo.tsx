/** The RAGForge mark: a ring cut open at the top, drawn in the current text colour. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <rect width="24" height="24" rx="6" className="fill-foreground" />
      <path d="M8.2 8.6A5.2 5.2 0 1 0 15.8 8.6" className="stroke-background" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
