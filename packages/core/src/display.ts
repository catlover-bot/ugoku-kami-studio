/** Display only. Keep full precision in input fields, geometry, hashes and PDFs. */
export function displayDimension(value: number): string {
  const rounded = Number(value.toFixed(2));
  return `${rounded === value ? '' : '約'}${rounded}`;
}
