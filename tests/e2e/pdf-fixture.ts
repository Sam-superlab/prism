export function pdfDocument(objects: string[]): Buffer {
  let document = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f '];
  objects.forEach((object, index) => {
    offsets.push(`${String(Buffer.byteLength(document)).padStart(10, '0')} 00000 n `);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const tableOffset = Buffer.byteLength(document);
  return Buffer.from(
    `${document}xref\n0 ${offsets.length}\n${offsets.join('\n')}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${tableOffset}\n%%EOF\n`,
  );
}

export const areaPdfFixture = {
  page: { width: 612, height: 792 },
  image: { x: 192, y: 400, width: 184, height: 120 },
  equation: { x: 192, y: 350, width: 184, height: 30 },
  header: 'Synthetic Journal of Algebra',
  footer: 'Synthetic article - confidential fixture',
};

export function pdfWithImageAndRepeatedMargins(): Buffer {
  const { page, image, equation, header, footer } = areaPdfFixture;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const font = objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // Four distinguishable RGB pixels scaled to a rectangle. A real image XObject
  // keeps the region independent of the selectable PDF text layer.
  const pixelData = 'd9e4ff7774c93a3b81c2caf1>';
  const figure = objects.push(
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixelData.length} >>\nstream\n${pixelData}\nendstream`,
  );
  const children: number[] = [];
  for (const pageNumber of [1, 2, 3]) {
    const content = [
      `BT /F1 10 Tf 42 761 Td (${header}) Tj ET`,
      `BT /F1 20 Tf 55 700 Td (Unique proof paragraph on page ${pageNumber}) Tj ET`,
      'BT /F1 14 Tf 55 660 Td (An additional body line for the synthetic paper.) Tj ET',
      `q ${image.width} 0 0 ${image.height} ${image.x} ${image.y} cm /Figure Do Q`,
      `BT /F1 18 Tf ${equation.x + 12} ${equation.y + 8} Td (x^2 + y^2 = z^2) Tj ET`,
      `BT /F1 10 Tf 42 27 Td (${footer}) Tj ET`,
    ].join('\n');
    const stream = objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    children.push(
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Figure ${figure} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${children.map((child) => `${child} 0 R`).join(' ')}] /Count ${children.length} >>`;
  return pdfDocument(objects);
}
