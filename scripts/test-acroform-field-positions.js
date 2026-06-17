/**
 * Atlas: Extract page + bounding-box coordinates for the 7 fields Carter
 * successfully filled, so we know where on each page the text actually lands.
 */
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const REPO_ROOT = path.resolve(__dirname, '..');
const TREC_RESALE_B64 = require(path.join(REPO_ROOT, 'api/_assets/trec-resale-20-19-base64.js'));

const FIELDS_TO_CHECK = [
  ['buyer_name', 'Seller and'],
  ['seller_name', '1 PARTIES The parties to this contract are'],
  ['property_address', 'Address of Property'],
  ['sales_price', 'will not be credited to the Sales Price at closing Time is of the'],
  ['sales_price_acknowledged', 'acknowledged by Seller and Buyers agreement to pay Seller'],
  ['earnest_money', 'earnest money of'],
  ['option_fee', 'Option Fee in the form of'],
  ['option_period_days', 'Within one'],
  ['title_company', 'insurance Title Policy issued by'],
  ['closing_date', 'A The closing of the sale will be on or before'],
];

async function main() {
  const bytes = Buffer.from(TREC_RESALE_B64, 'base64');
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const pages = doc.getPages();

  console.log('Total pages:', pages.length);
  console.log('Page sizes:', pages.map((p, i) => `pg${i + 1}=${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`).join(', '));
  console.log('');

  for (const [semantic, acroname] of FIELDS_TO_CHECK) {
    try {
      const field = form.getField(acroname);
      const widgets = field.acroField.getWidgets();
      const ftype = field.constructor.name;
      const locs = widgets.map((w, idx) => {
        const rect = w.getRectangle();
        // Find which page contains this widget
        const pageRef = w.P();
        let pageNum = '?';
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].ref === pageRef) { pageNum = i + 1; break; }
        }
        return `pg${pageNum} x=${Math.round(rect.x)} y=${Math.round(rect.y)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`;
      });
      console.log(`${semantic} [${ftype}] -> "${acroname}":`);
      locs.forEach((l) => console.log('   ' + l));
    } catch (e) {
      console.log(`${semantic}: ERROR ${e.message}`);
    }
  }
}

main().catch(console.error);
