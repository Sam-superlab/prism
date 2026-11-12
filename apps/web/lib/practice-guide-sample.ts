/** A single exercise with a square root whose bar was not preserved by the source PDF. */
export function exampleExercisePdf() {
  const stream = [
    'BT /F1 12 Tf 60 724 Td (Exercises) Tj ET',
    'BT /F1 12 Tf 60 688 Td (1. Check ) Tj ET',
    'BT /F3 12 Tf 114.684 697.4 Td <D6> Tj ET',
    'BT /F2 12 Tf 121.272 688 Td (5) Tj ET',
    'BT /F1 12 Tf 127.272 688 Td (.) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
  ];
  // All content is ASCII, so string lengths are byte offsets in the PDF.
  let pdf = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f '];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, '0')} 00000 n `);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n${offsets.join('\n')}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([pdf], 'pip-practice.pdf', { type: 'application/pdf' });
}
