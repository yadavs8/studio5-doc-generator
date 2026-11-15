// Studio5's own identity, held on the server so a request cannot put someone else's GSTIN or
// bank account on a signed Studio5 document (decision 0001).

const STUDIO5_GSTINS = ["06ABICS6962P1ZG", "07ABICS6962P1ZE"];

const BANK_ACCOUNTS = [
  { key: "hdfc", name: "HDFC BANK LIMITED", account: "50200120135932", ifsc: "HDFC0003676",
    branch: "SPENDOUR TRADE TOWER, GOLF COURSE EXTN ROAD, SECTOR - 65, GURGAON" },
  { key: "idfc", name: "IDFC FIRST BANK LIMITED", account: "10103784405", ifsc: "IDFB0020134",
    branch: "DWARKA SECTOR 12 A, NEW DELHI-110078" },
];

// GST state codes (first two digits of a GSTIN).
const STATES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

const norm = (s) => String(s || "").trim().toUpperCase();
const isStudio5Gstin = (gstin) => STUDIO5_GSTINS.includes(norm(gstin));
const findBank = (bank) => (bank && BANK_ACCOUNTS.find((b) => b.account === String(bank.account || "").trim())) || null;
const stateName = (code) => STATES[code] || null;
/** The state code a GSTIN belongs to, or null if it is not a well-formed GSTIN. */
const gstinState = (gstin) => {
  const g = norm(gstin);
  return /^\d{2}[A-Z0-9]{13}$/.test(g) && STATES[g.slice(0, 2)] ? g.slice(0, 2) : null;
};

module.exports = { STUDIO5_GSTINS, BANK_ACCOUNTS, STATES, isStudio5Gstin, findBank, stateName, gstinState };
