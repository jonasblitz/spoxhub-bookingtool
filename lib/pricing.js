const zones = require('../data/zones.json');
const { getCatalogForVehicle } = require('./catalog');

/**
 * Finde eine Leistung im Katalog nach ID
 */
async function findLeistung(id, vehicleType) {
  const catalog = await getCatalogForVehicle(vehicleType || 'ebike');
  for (const bereich of catalog.bereiche) {
    const found = bereich.leistungen.find(l => l.id === id);
    if (found) return found;
  }
  return null;
}

function getTravelFee(travelTimeMinutes) {
  if (travelTimeMinutes == null) return 0;
  const sorted = [...zones.zones].sort((a, b) => a.maxMinutes - b.maxMinutes);
  for (const zone of sorted) {
    if (travelTimeMinutes <= zone.maxMinutes) return zone.fee;
  }
  return sorted[sorted.length - 1].fee;
}

// Inspektions-Bonus: 60 Min Arbeitszeit für „In Inspektion enthalten"-Leistungen frei,
// alles darüber wird zum Standard-Minutensatz berechnet.
const INSPEKTION_FREE_MINUTES = 60;
const RATE_PER_MINUTE = 2; // €/min — universal

async function calculatePricing({ serviceIds, quantities, vehicleType, locationType, travelTimeMinutes }) {
  if (!vehicleType) vehicleType = 'ebike';
  quantities = quantities || {};

  const lineItems = [];

  for (const serviceId of serviceIds) {
    const leistung = await findLeistung(serviceId, vehicleType);
    if (!leistung) continue;

    const maxQty = leistung.maxQuantity || 1;
    const rawQty = Number(quantities[serviceId]) || 1;
    const qty = Math.max(1, Math.min(maxQty, rawQty));

    // Marginal calculation:
    //   work + material per item, where work is reduced from the 2nd unit onwards
    //   (if PreisZusatz/DauerZusatz are set in Airtable).
    const addPrice    = leistung.addPrice    != null ? leistung.addPrice    : leistung.priceWork;
    const addDuration = leistung.addDuration != null ? leistung.addDuration : leistung.duration;
    const material    = leistung.priceMaterial || 0;

    const totalWorkPrice    = leistung.priceWork + (qty - 1) * addPrice;
    const totalDuration     = leistung.duration  + (qty - 1) * addDuration;
    const totalMaterialCost = material * qty;
    const totalPrice        = totalWorkPrice + totalMaterialCost;

    lineItems.push({
      id: leistung.id,
      name: leistung.name,
      bereich: leistung.bereich,
      quantity: qty,
      unitPrice: leistung.price,
      price: totalPrice,
      workPrice: totalWorkPrice,
      materialPrice: totalMaterialCost,
      duration: totalDuration,
      materialkosten: leistung.materialkosten,
      materialsIncluded: leistung.materialsIncluded,
      maxQuantity: maxQty,
      eterminId: leistung.eterminId,
      inInspektionEnthalten: !!leistung.inInspektionEnthalten,
      includedInInspektion: false
    });
  }

  // Apply Inspektion bonus if Inspektion is in the cart
  const hasInspektion = lineItems.some(i => i.bereich === 'Inspektion');
  let inspektionOverage = null;

  if (hasInspektion) {
    const freebieItems = lineItems.filter(
      i => i.inInspektionEnthalten && i.bereich !== 'Inspektion'
    );
    const totalFreeMinutes = freebieItems.reduce((s, i) => s + i.duration, 0);

    if (freebieItems.length > 0) {
      // Each freebie line: zero out work cost, keep material
      freebieItems.forEach(i => {
        i.workPrice = 0;
        i.price = i.materialPrice;
        i.includedInInspektion = true;
      });

      // Pro-rata: anything beyond 60 minutes is charged at the standard rate
      if (totalFreeMinutes > INSPEKTION_FREE_MINUTES) {
        const overageMin = totalFreeMinutes - INSPEKTION_FREE_MINUTES;
        const overageCost = overageMin * RATE_PER_MINUTE;
        inspektionOverage = {
          minutes: overageMin,
          cost: Math.round(overageCost * 100) / 100,
          rate: RATE_PER_MINUTE
        };
      }
    }
  }

  const lineSubtotal = lineItems.reduce((sum, item) => sum + item.price, 0);
  const overageCost  = inspektionOverage?.cost || 0;
  const subtotal     = lineSubtotal + overageCost;
  const travelFee    = locationType === 'werkstatt' ? 0 : getTravelFee(travelTimeMinutes);
  const total        = Math.round((subtotal + travelFee) * 100) / 100;
  const estimatedDurationMinutes = lineItems.reduce((sum, item) => sum + item.duration, 0);

  return {
    lineItems,
    subtotal: Math.round(subtotal * 100) / 100,
    travelFee,
    total,
    estimatedDurationMinutes,
    vehicleType,
    inspektionOverage
  };
}

module.exports = { calculatePricing, findLeistung };
