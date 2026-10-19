import fs from 'fs';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import * as xlsx from 'xlsx';

/**
 * Normalizes phone number:
 * - Strips non-digit chars (except leading +)
 * - If countryCode is provided and number has no + and looks local (e.g. 10 digits), prepends countryCode
 */
export function formatPhoneNumber(rawPhone, defaultCountryCode = '91') {
  if (!rawPhone) return null;
  
  let cleaned = String(rawPhone).trim();
  // Remove spaces, hyphens, brackets, dots
  cleaned = cleaned.replace(/[\s\-\(\)\.]/g, '');

  // If starts with 00, replace with +
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  // Remove leading + for numeric checking
  const hasPlus = cleaned.startsWith('+');
  let digits = cleaned.replace(/\D/g, '');

  if (!digits) return null;

  // If starts with 0 and followed by 10 digits (common local format in many countries)
  if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1);
  }

  // If only 10 digits (standard mobile number without country code), prepend default country code
  const cleanCode = defaultCountryCode.replace(/\D/g, '');
  if (digits.length === 10 && cleanCode) {
    digits = cleanCode + digits;
  }

  // WhatsApp JID expects only digits without +: e.g. 919876543210
  return {
    digits,
    formatted: '+' + digits,
    jid: `${digits}@s.whatsapp.net`
  };
}

/**
 * Parse Google Contacts CSV or general CSV
 */
export function parseCsvContacts(fileBufferOrString, defaultCountryCode = '91') {
  const content = Buffer.isBuffer(fileBufferOrString) ? fileBufferOrString.toString('utf-8') : fileBufferOrString;
  const records = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const contacts = [];
  const seenNumbers = new Set();

  for (const row of records) {
    // 1. Determine Contact Name
    let name = row['Name'] || row['Full Name'] || row['Contact Name'] || '';
    if (!name) {
      const given = row['Given Name'] || row['First Name'] || '';
      const family = row['Family Name'] || row['Last Name'] || '';
      name = `${given} ${family}`.trim();
    }

    // 2. Extract Phone Numbers (Google Contacts has Phone 1 - Value, Phone 2 - Value, etc.)
    const phoneCandidates = [];

    // Check all keys in row for phone matches
    for (const [key, val] of Object.entries(row)) {
      if (!val) continue;
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('phone') ||
        lowerKey.includes('mobile') ||
        lowerKey.includes('cell') ||
        lowerKey.includes('tel') ||
        lowerKey.includes('contact no') ||
        lowerKey.includes('whatsapp') ||
        lowerKey === 'number'
      ) {
        phoneCandidates.push(String(val));
      }
    }

    // If no direct phone column, check if any value looks like a phone number
    if (phoneCandidates.length === 0) {
      for (const val of Object.values(row)) {
        if (!val) continue;
        const cleaned = String(val).replace(/\D/g, '');
        if (cleaned.length >= 7 && cleaned.length <= 15) {
          phoneCandidates.push(String(val));
          break;
        }
      }
    }

    // Process each candidate phone
    for (const rawPhone of phoneCandidates) {
      const formatted = formatPhoneNumber(rawPhone, defaultCountryCode);
      if (formatted && formatted.digits.length >= 8) {
        if (!seenNumbers.has(formatted.digits)) {
          seenNumbers.add(formatted.digits);
          const finalName = name || `Contact ${contacts.length + 1}`;
          const firstName = finalName.split(' ')[0] || finalName;
          contacts.push({
            id: `c_${Date.now()}_${contacts.length}`,
            name: finalName,
            firstName,
            rawPhone,
            phone: formatted.formatted,
            digits: formatted.digits,
            jid: formatted.jid
          });
        }
      }
    }
  }

  return contacts;
}

/**
 * Parse vCard (.vcf) contacts (Standard Google Contacts export format)
 */
export function parseVcfContacts(fileBufferOrString, defaultCountryCode = '91') {
  const content = Buffer.isBuffer(fileBufferOrString) ? fileBufferOrString.toString('utf-8') : fileBufferOrString;
  const cards = content.split(/BEGIN:VCARD/i);
  const contacts = [];
  const seenNumbers = new Set();

  for (const card of cards) {
    if (!card.trim()) continue;

    let name = '';
    const phones = [];

    const lines = card.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('FN:') || trimmed.startsWith('FN;')) {
        name = trimmed.replace(/^FN[;:].*?:/i, '').replace(/^FN:/i, '').trim();
      } else if (!name && (trimmed.startsWith('N:') || trimmed.startsWith('N;'))) {
        const parts = trimmed.replace(/^N[;:].*?:/i, '').replace(/^N:/i, '').split(';');
        const last = parts[0] || '';
        const first = parts[1] || '';
        name = `${first} ${last}`.trim();
      } else if (trimmed.toUpperCase().includes('TEL')) {
        const phoneVal = trimmed.replace(/^.*?TEL.*?:/i, '').trim();
        if (phoneVal) phones.push(phoneVal);
      }
    }

    for (const rawPhone of phones) {
      const formatted = formatPhoneNumber(rawPhone, defaultCountryCode);
      if (formatted && formatted.digits.length >= 8) {
        if (!seenNumbers.has(formatted.digits)) {
          seenNumbers.add(formatted.digits);
          const finalName = name || `Contact ${contacts.length + 1}`;
          const firstName = finalName.split(' ')[0] || finalName;
          contacts.push({
            id: `c_${Date.now()}_${contacts.length}`,
            name: finalName,
            firstName,
            rawPhone,
            phone: formatted.formatted,
            digits: formatted.digits,
            jid: formatted.jid
          });
        }
      }
    }
  }

  return contacts;
}

/**
 * Parse Excel (.xlsx / .xls)
 */
export function parseExcelContacts(fileBuffer, defaultCountryCode = '91') {
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const records = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

  const contacts = [];
  const seenNumbers = new Set();

  for (const row of records) {
    let name = row['Name'] || row['Full Name'] || row['Contact Name'] || row['First Name'] || '';
    const phoneCandidates = [];

    for (const [key, val] of Object.entries(row)) {
      if (!val) continue;
      const lower = key.toLowerCase();
      if (
        lower.includes('phone') ||
        lower.includes('mobile') ||
        lower.includes('cell') ||
        lower.includes('number') ||
        lower.includes('contact')
      ) {
        phoneCandidates.push(String(val));
      }
    }

    for (const rawPhone of phoneCandidates) {
      const formatted = formatPhoneNumber(rawPhone, defaultCountryCode);
      if (formatted && formatted.digits.length >= 8) {
        if (!seenNumbers.has(formatted.digits)) {
          seenNumbers.add(formatted.digits);
          const finalName = name || `Contact ${contacts.length + 1}`;
          contacts.push({
            id: `c_${Date.now()}_${contacts.length}`,
            name: finalName,
            firstName: finalName.split(' ')[0] || finalName,
            rawPhone,
            phone: formatted.formatted,
            digits: formatted.digits,
            jid: formatted.jid
          });
        }
      }
    }
  }

  return contacts;
}

/**
 * Parse raw pasted text (e.g. one contact per line or CSV)
 * Format can be:
 * John Doe, 9876543210
 * or just:
 * 9876543210
 */
export function parseRawTextContacts(text, defaultCountryCode = '91') {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const contacts = [];
  const seenNumbers = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let name = '';
    let rawPhone = '';

    if (trimmed.includes(',')) {
      const parts = trimmed.split(',');
      name = parts[0].trim();
      rawPhone = parts.slice(1).join(',').trim();
    } else if (trimmed.includes('\t')) {
      const parts = trimmed.split('\t');
      name = parts[0].trim();
      rawPhone = parts.slice(1).join(' ').trim();
    } else {
      rawPhone = trimmed;
    }

    const formatted = formatPhoneNumber(rawPhone, defaultCountryCode);
    if (formatted && formatted.digits.length >= 8) {
      if (!seenNumbers.has(formatted.digits)) {
        seenNumbers.add(formatted.digits);
        const finalName = name || `Contact ${contacts.length + 1}`;
        contacts.push({
          id: `c_${Date.now()}_${contacts.length}`,
          name: finalName,
          firstName: finalName.split(' ')[0] || finalName,
          rawPhone,
          phone: formatted.formatted,
          digits: formatted.digits,
          jid: formatted.jid
        });
      }
    }
  }

  return contacts;
}
