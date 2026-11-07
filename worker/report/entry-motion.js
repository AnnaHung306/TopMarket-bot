export const reportEntryMotionStyles = String.raw`
@media screen and (prefers-reduced-motion: no-preference) {
  .header-inner > :is(.header-brand, .network),
  .intro > :is(.eyebrow, h1, p:first-of-type),
  main > :is(.query, .overview, .poster) {
    animation: report-entry 560ms cubic-bezier(.22, 1, .36, 1) both;
    animation-delay: var(--report-entry-delay, 0ms);
  }

  .network { --report-entry-delay: 65ms; }
  .intro > .eyebrow { --report-entry-delay: 130ms; }
  .intro > h1 { --report-entry-delay: 195ms; }
  .intro > p:first-of-type { --report-entry-delay: 260ms; }
  main > .query { --report-entry-delay: 325ms; }
  main > .overview { --report-entry-delay: 390ms; }
  main > .poster { --report-entry-delay: 455ms; }

  /* Show a focused control immediately without restarting the animation on blur. */
  main > :is(.query, .overview, .poster):focus-within {
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
}

@media screen and (max-width: 830px) {
  main > .poster { animation: none; }
}

@keyframes report-entry {
  from { opacity: .12; transform: translateY(10px); filter: blur(6px); }
  /* End with a neutral segment so the filled animation releases blur and transform. */
  99.9%, to { opacity: 1; transform: none; filter: none; }
}
`;
