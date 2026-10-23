import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isOneTimeCode, fingerprint, normYear, findDate, parseBangkokBank, parseGenericCard, parseKnownFormats,
  normalizePayment, extractCharge, PAYMENT_SCHEMA, cleanText,
} from '../src/chargeParse.js';

// Fictional copy of a Bangkok Bank payment confirmation (layout only).
const BBL = readFileSync(new URL('./fixtures/bbl-payment.txt', import.meta.url), 'utf8');

test('Bangkok Bank payment e-mail: payee, amount, date, account digits', () => {
  const c = parseBangkokBank(BBL);
  assert.equal(c.kind, 'payment');
  assert.equal(c.merchant, 'DEMO NOODLE SHOP (ทดสอบ)');
  assert.equal(c.amount, 45);
  assert.equal(c.currency, 'THB');
  assert.equal(c.on, '2026-10-05'); // 5 ตุลาคม 2569
  assert.equal(c.time, '12:30');
  assert.equal(c.cardLast4, '567');
  assert.equal(c.parser, 'bbl');
  // the bank's "we never ask for your password" note is not a one-time code
  assert.equal(isOneTimeCode(BBL), false);
});

test('Bangkok Bank e-mail as Gmail plain text: CRLF, labels on their own line, no-break spaces', () => {
  const plain = BBL.replace(/\t+ ?/g, '\r\n').replace(/ /g, ' ');
  const c = parseBangkokBank(plain);
  assert.equal(c.merchant, 'DEMO NOODLE SHOP (ทดสอบ)');
  assert.equal(c.amount, 45);
  assert.equal(c.on, '2026-10-05');
  // English block only
  const en = BBL.slice(BBL.indexOf('Automatic e-mail'));
  const e = parseBangkokBank(en);
  assert.equal(e.merchant, 'DEMO NOODLE SHOP (ทดสอบ)');
  assert.equal(e.amount, 45);
  assert.equal(e.on, '2026-10-05');
  assert.equal(e.time, '12:30');
});

test('Bangkok Bank: transfers are told apart, other banks are not read as BBL', () => {
  const transfer = BBL.replace('ยืนยันการจ่ายเงิน', 'ยืนยันการโอนเงิน');
  assert.equal(parseBangkokBank(transfer).kind, 'transfer');
  assert.equal(parseBangkokBank('จำนวนเงิน (บาท) 45.00 ชื่อบริษัท / ชื่อผู้ให้บริการ X'), null);
  assert.equal(parseBangkokBank('ธนาคารกรุงเทพ ขอแจ้งข่าวสาร'), null);
});

test('card SMS shapes in Thai and English', () => {
  const cases = [
    ['บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM 23/10/69 10:05', { merchant: 'NETFLIX.COM', amount: 419, currency: 'THB', on: '2026-10-23', time: '10:05', cardLast4: '1234' }],
    ['Your card ending 1234 was charged USD 20.00 at OPENAI *CHATGPT SUBSCR on 23 Oct 2026', { merchant: 'OPENAI *CHATGPT SUBSCR', amount: 20, currency: 'USD', on: '2026-10-23', cardLast4: '1234' }],
    ['ยอดใช้จ่ายบัตร xx9876 จำนวน 1,290.00 บาท ที่ SPOTIFY P1A2B3 วันที่ 03/11/2569 เวลา 08:00', { merchant: 'SPOTIFY P1A2B3', amount: 1290, on: '2026-11-03', time: '08:00', cardLast4: '9876' }],
    ['Transaction alert: THB 35.00 at APPLE.COM/BILL on 23-10-2026 10:05 with card ***1234', { merchant: 'APPLE.COM/BILL', amount: 35, on: '2026-10-23', cardLast4: '1234' }],
  ];
  for (const [text, want] of cases) {
    const c = parseGenericCard(text);
    assert.ok(c, text);
    assert.equal(c.kind, 'charge', text);
    for (const [k, v] of Object.entries(want)) assert.equal(c[k], v, `${k} in ${text}`);
  }
});

test('card SMS: refunds, adverts and chatter', () => {
  assert.equal(parseGenericCard('คืนเงิน 419.00 บาท ที่ NETFLIX.COM 24/10/69').kind, 'refund');
  assert.equal(parseGenericCard('ช้อปลด 50% ที่ Lazada ใช้จ่ายครบ 1,000 บาท'), null);
  assert.equal(parseGenericCard('Spend THB 1,000 at Central and get cashback'), null);
  assert.equal(parseGenericCard('ไปกินข้าวที่สยามกัน'), null);
  assert.equal(parseGenericCard('ใช้จ่าย 0.00 บาท ที่ TEST'), null);
  // known formats: BBL first, then the generic reader
  assert.equal(parseKnownFormats(BBL).parser, 'bbl');
  assert.equal(parseKnownFormats('บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM').parser, 'generic');
  assert.equal(parseKnownFormats('hello'), null);
});

test('one-time codes are recognised and never treated as charges', () => {
  assert.ok(isOneTimeCode('รหัส OTP ของคุณคือ 123456 (Ref: ABCD) ใช้ภายใน 5 นาที'));
  assert.ok(isOneTimeCode('Your verification code is 482913'));
  assert.ok(isOneTimeCode('OTP=829112 for payment of THB 419.00 at NETFLIX.COM'));
  assert.ok(isOneTimeCode('One-time password: 1234'));
  assert.equal(isOneTimeCode('บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM'), false);
});

test('years: Buddhist and two-digit', () => {
  assert.equal(normYear(2569), 2026);
  assert.equal(normYear(2026), 2026);
  assert.equal(normYear(69), 2026);
  assert.equal(normYear(26), 2026);
  assert.equal(normYear('x'), null);
});

test('findDate skips things that only look like dates', () => {
  assert.deepEqual(findDate('20.00 THB 23 Oct 2026'), { on: '2026-10-23', time: '' });
  assert.deepEqual(findDate('19 ส.ค. 69 10.05 น.'), { on: '2026-08-19', time: '10:05' });
  assert.deepEqual(findDate('ref 1 UI146 31/02/2026 then 01/03/2026 09:15'), { on: '2026-03-01', time: '09:15' });
  assert.equal(findDate('amount 419.00 version 1.2.3'), null);
  assert.equal(findDate(''), null);
});

test('fingerprints: by message id when given, else by normalised text', () => {
  assert.equal(fingerprint({ source: 'email', id: 'abc' }), 'email:abc');
  const a = fingerprint({ text: 'บัตร  xx1234\nใช้จ่าย 419.00' });
  const b = fingerprint({ text: 'บัตร xx1234 ใช้จ่าย 419.00 ' });
  assert.equal(a, b);
  assert.notEqual(a, fingerprint({ text: 'บัตร xx1234 ใช้จ่าย 420.00' }));
  assert.ok(!a.includes('419')); // the text itself is not kept
  assert.equal(cleanText('a\r\nb c'), 'a\nb c');
});

test('AI result is checked before it becomes a charge', () => {
  assert.equal(normalizePayment({ kind: 'none', merchant: 'x', amount: 1 }), null);
  assert.equal(normalizePayment({ kind: 'charge', merchant: '', service: '', amount: 10 }), null);
  assert.equal(normalizePayment({ kind: 'charge', merchant: 'Shop', amount: 0 }), null);
  const trial = normalizePayment({ kind: 'trial_started', merchant: '', service: 'ChatGPT Plus', amount: 0, currency: 'usd', date: '2026-10-23', card_last4: '•••• 1234', cycle: 'monthly', trial_end_date: '2026-11-22', looks_recurring: true });
  assert.equal(trial.merchant, 'ChatGPT Plus');
  assert.equal(trial.currency, 'THB'); // lower-case code is not trusted
  assert.equal(trial.cardLast4, '1234');
  assert.equal(trial.trialEndsOn, '2026-11-22');
  assert.equal(normalizePayment({ kind: 'charge', merchant: 'X', amount: 5, date: '2026-02-30' }).on, '');
  assert.deepEqual(PAYMENT_SCHEMA.required.sort(), Object.keys(PAYMENT_SCHEMA.properties).sort());
  assert.equal(PAYMENT_SCHEMA.additionalProperties, false);
});

test('extractCharge sends the text with today in the prompt', async () => {
  let seen;
  const provider = { async extract(req) { seen = req; return { kind: 'charge', merchant: 'NETFLIX.COM', service: 'Netflix', amount: 419, currency: 'THB', date: '2026-10-23', card_last4: '1234', cycle: 'monthly', trial_end_date: '', looks_recurring: true }; } };
  const c = await extractCharge(provider, 'some bank text', { now: new Date('2026-10-23T03:00:00Z') });
  assert.match(seen.system, /Today is 2026-10-23/);
  assert.equal(seen.schema, PAYMENT_SCHEMA);
  assert.equal(c.service, 'Netflix');
  assert.equal(c.parser, 'ai');
});
