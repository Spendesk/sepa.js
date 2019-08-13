/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2014-2015 */

/**
 * This is sepa.js. Its module exports the following functions:
 *
 * SEPA.Document               -- class for creating SEPA XML Documents
 * SEPA.PaymentInfo            -- class for SEPA payment information blocks
 * SEPA.Transaction            -- class for generic transactions
 * SEPA.validateIBAN           -- function to validate an IBAN
 * SEPA.checksumIBAN           -- function to calculate the IBAN checksum
 * SEPA.validateCreditorID     -- function to validate a creditor id
 * SEPA.checksumCreditorID     -- function to calculate the creditor id checksum
 * SEPA.setIDSeparator         -- function to customize the ID separator when needed (defaults to '.')
 * SEPA.enableValidations      -- function to enable/disable fields validation
*/
const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';
const XSI_NS        = 'urn:iso:std:iso:20022:tech:xsd:';
const DEFAULT_XML_VERSION   = '1.0';
const DEFAULT_XML_ENCODING  = 'UTF-8';
const DEFAULT_PAIN_FORMAT   = 'pain.008.001.02';

let ID_SEPARATOR = '.';
function setIDSeparator(seperator) {
  ID_SEPARATOR = seperator;
}

let VALIDATIONS_ENABLED = true;
function enableValidations(enabled) {
  VALIDATIONS_ENABLED = !!enabled;
}

const SEPATypes = {
  'pain.001.001.02': 'pain.001.001.02',
  'pain.001.003.02': 'pain.001.003.02',
  'pain.001.001.03': 'CstmrCdtTrfInitn',
  'pain.001.003.03': 'CstmrCdtTrfInitn',
  'pain.008.001.01': 'pain.008.001.01',
  'pain.008.003.01': 'pain.008.003.01',
  'pain.008.001.02': 'CstmrDrctDbtInitn',
  'pain.008.003.02': 'CstmrDrctDbtInitn'
};

class InvalidSupplierError extends Error {
  supplierName: string;
  invalidParams;

  constructor(supplierName, invalidParams, ...params) {
    // Pass remaining arguments (including vendor specific ones) to parent constructor
    super(...params);

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidSupplierError);
    }

    this.name = 'InvalidSupplierError';
    // Custom debugging information
    this.supplierName = supplierName;
    this.invalidParams = invalidParams;
  }
}

function getPainXMLVersion(painFormat) {
  const inc = painFormat.indexOf('pain.008') === 0 ?  1 : 0;
  return parseInt(painFormat.substr(-2), 10) + inc;
}

class SepaDocument {
  static Types = SEPATypes;

  /** Pain Format used */
  _painFormat: string;

  /** SEPA Document type setting, contains the root element */
  _type: string;

  /** Payment Info array */
  _paymentInfo: SepaPaymentInfo[] = [];

  /** Xml version */
  _xmlVersion: string = DEFAULT_XML_VERSION;

  /** Xml encoding */
  _xmlEncoding: string = DEFAULT_XML_ENCODING;

  /** Group Header object */
  grpHdr: SepaGroupHeader;

  constructor(painFormat) {
    this._painFormat = painFormat || DEFAULT_PAIN_FORMAT;
    this._type = SEPATypes[this._painFormat];
    this.grpHdr = new SepaGroupHeader(this._painFormat);
  }

  /**
   * Adds a Sepa.PaymentInfo block to this document. Its id will be
   * automatically prefixed with the group header id.
   *
   * @param pi        The payment info block.
   */
  addPaymentInfo(pi: SepaPaymentInfo) {
    if (!(pi instanceof SepaPaymentInfo)) {
      throw new Error('Given payment is not member of the PaymentInfo class');
    }

    if (pi.overrideReference) {
      pi.id = pi.overrideReference;
    } else if (pi.id) {
      pi.id = this.grpHdr.id + ID_SEPARATOR + pi.id;
    } else {
      pi.id = this.grpHdr.id + ID_SEPARATOR + this._paymentInfo.length;
    }
    this._paymentInfo.push(pi);
  }

  /**
   * Factory method for PI
   */
  createPaymentInfo() {
    return new SepaPaymentInfo(this._painFormat);
  }

  /**
   * Normalize fields like the control sum or transaction count. This will be
   * called automatically when serialized to XML.
   */
  normalize() {
    let controlSum = 0;
    let txCount = 0;
    for (let i = 0, l = this._paymentInfo.length; i < l; ++i) {
      this._paymentInfo[i].normalize();
      controlSum += this._paymentInfo[i].controlSum;
      txCount += this._paymentInfo[i].transactionCount;
    }
    this.grpHdr.controlSum = controlSum;
    this.grpHdr.transactionCount = txCount;
  }

  /**
   * Serialize this document to a DOM Document.
   *
   * @return      The DOM Document.
   */
  toXML() {
    this.normalize();

    const docNS = XSI_NS + this._painFormat;
    let doc = createDocument(docNS, 'Document');
    doc.xmlVersion = this._xmlVersion;
    doc.xmlEncoding = this._xmlEncoding;
    let body = doc.documentElement;

    body.setAttribute('xmlns:xsi', XSI_NAMESPACE);
    body.setAttribute('xsi:schemaLocation', XSI_NS + this._painFormat + ' ' + this._painFormat + '.xsd');
    let rootElement = doc.createElementNS(docNS, this._type);
    rootElement.appendChild(this.grpHdr.toXML(doc));
    for (let i = 0, l = this._paymentInfo.length; i < l; ++i) {
      rootElement.appendChild(this._paymentInfo[i].toXML(doc));
    }

    doc.documentElement.appendChild(rootElement);
    return doc;
  }

  /**
   * Serialize this document to an XML string.
   *
   * @return String     The XML string of this document.
   */
  toString() {
    console.log("SRINGIFYIIIIING!!!");
    let doc = this.toXML();
    // as some banks require the document declaration string and it is not provided by the XMLSerializer, it is added here.
    const docDeclaration = '<?xml version="' + doc.xmlVersion + '" encoding="' + doc.xmlEncoding + '"?>';
    return docDeclaration + serializeToString(doc);
  }
}

/**
 * Wrapper class for the SEPA <GrpHdr> element.
 */
class SepaGroupHeader {
  _painFormat: string;

  id: string = '';
  created: Date;
  transactionCount: number = 0;
  initiatorName: string = '';

  /**
   * Used by spanish companies it's mandatory for SEPA in spain.
   */
  cifNumber: string = '';
  /**
   * Used by italian bank and mandatory for them.
   */
  cucNumber: string = '';
  controlSum: number = 0;
  batchBooking: boolean = false;
  grouping: string = 'MIXD';

  constructor(painFormat) {
    this._painFormat = painFormat;
  }

  /*
    * Serialize this document to a DOM Element.
    *
    * @return      The DOM <GrpHdr> Element.
    */
  toXML(doc) {
    const r = createXMLHelper(doc, true, true);
    let grpHdr = doc.createElementNS(doc.documentElement.namespaceURI, 'GrpHdr');
    const painVersion = getPainXMLVersion(this._painFormat);

    r(grpHdr, 'MsgId', this.id);
    r(grpHdr, 'CreDtTm', this.created.toISOString());

    // XML v2 formats, add grouping + batch booking nodes
    if (painVersion === 2) {
      r(grpHdr, 'BtchBookg', this.batchBooking.toString());
    }

    r(grpHdr, 'NbOfTxs', this.transactionCount);
    r(grpHdr, 'CtrlSum', this.controlSum.toFixed(2));

    // XML v2 formats, add grouping + batch booking nodes
    if (painVersion === 2) {
      r(grpHdr, 'Grpg', this.grouping);
    }

    const n = createXMLHelper(doc, true, false);
    let initgPty = n(grpHdr, 'InitgPty');
    r(initgPty, 'Nm', this.initiatorName);
    if (this.cifNumber) {
      r(initgPty, 'Id', 'OrgId', 'Othr', 'Id', this.cifNumber);
    }
    if (this.cucNumber) {
      const p = createXMLHelper(doc, true, false);
      let other = p(initgPty, 'Id', 'OrgId', 'Othr');
      r(other, 'Id', this.cucNumber);
      r(other, 'Issr', 'CBI');
    }

    return grpHdr;
  }

  /**
   * Serialize this element to an XML string.
   *
   * @return      The XML string of this element.
   */
  toString() {
    return serializeToString(this.toXML(this));
  }
}

const PaymentInfoTypes = {
  DirectDebit: 'DD',
  Transfer: 'TRF'
};

/**
 * Wrapper class for the SEPA <PmtInf> Element
 */
class SepaPaymentInfo {
  static PaymentInfoTypes = PaymentInfoTypes;
  
  _painFormat: string;

  /** Transaction array */
  _payments: SepaTransaction[] = [];

  id: string = '';

  /** SEPA payment method. */
  method: string;

  /** If true, booking will appear as one entry on your statement */
  batchBooking: boolean = false;

  /** Grouping, defines structure handling for XML file */
  grouping: string = 'MIXD';

  /** Sum of all payments, will be automatically set */
  controlSum: number = 0;

  /* Instrumentation code:
    * 'CORE' - Standard Transfer
    * 'COR1' - Expedited Transfer
    * 'B2B'  - Business Transfer
    */
  localInstrumentation: string = 'CORE';

  /**
   * 'FRST' - First transfer
   * 'RCUR' - Subsequent transfer
   * 'OOFF' - One Off transfer
   * 'FNAL' - Final transfer
   */
  sequenceType: string = 'FRST';

  /** Requested collection date */
  collectionDate: Date = null;

  /** Execution date of the SEPA order */
  requestedExecutionDate: Date = null;

  /** Id assigned to the creditor */
  creditorId: string = '';

  /** Name, Address, IBAN and BIC of the creditor */
  creditorName: string = '';
  creditorStreet: string = null;
  creditorCity: string = null;
  creditorCountry: string = null;
  creditorIBAN: string = '';
  creditorBIC: string = '';
  creditorMemberId: string = '';

  /** Id assigned to the debtor for Transfer payments */
  debtorId: string = '';

  /** Name, Address, IBAN and BIC of the debtor */
  debtorName: string = '';
  debtorStreet: string = null;
  debtorCity: string = null;
  debtorCountry: string = null;
  debtorIBAN: string = '';
  debtorBIC: string = '';
  debtorMemberId: string = '';

  /** SEPA order priority, can be HIGH or NORM */
  instructionPriority: string = 'NORM';
  /**
   * Mostly used value.
   * SALA  SalaryPayment  Payment of salaries.
   * SSBE  SocialSecurityBenefit  Payment of child benefit, family allowance.
   * SUPP  SupplierPayment  Payment to a supplier.
   * RIMB  Reimbursement
   * OTHR  Other generic
   * https://wiki.xmldation.com/Support/Febelfin/Direct_Debit/CtgyPurp%2F%2FCd
   */
  categoryPurpose: string = '';

  overrideReference: string = '';

  constructor(painFormat) {
    this._painFormat = painFormat;
    this.method = painFormat.indexOf('pain.001') === 0 ?PaymentInfoTypes.Transfer : PaymentInfoTypes.DirectDebit;
  }

  /** Number of transactions in this payment info block */
  get transactionCount() {
    return this._payments.length;
  }

  /**
   * Normalize fields like the control sum or transaction count. This will
   * _NOT_ be called when serialized to XML and must be called manually.
   */
  normalize() {
    let controlSum = 0;
    for (let i = 0, l = this._payments.length; i < l; ++i) {
      controlSum += this._payments[i].amount;
    }
    this.controlSum = controlSum;
  }

  /**
   * Adds a transaction to this payment. The transaction id will be prefixed
   * by the payment info id.
   *
   * @param pmt       The Transaction to add.
   */
  addTransaction(pmt: SepaTransaction) {
    if (!(pmt instanceof SepaTransaction)) {
      throw new Error('Given Transaction is not member of the SepaTransaction class');
    }

    if (pmt.overrideReference) {
      pmt.id = pmt.overrideReference;
    } else if (pmt.id) {
      pmt.id = this.id + ID_SEPARATOR + pmt.id;
    } else {
      pmt.id = this.id + ID_SEPARATOR + this._payments.length;
    }
    this._payments.push(pmt);
  }

  createTransaction() {
    return new SepaTransaction(this._painFormat);
  }

  validate() {

    // TODO consider using getters/setters instead
    const pullFrom = this.method === PaymentInfoTypes.DirectDebit ? 'creditor' : 'debtor';

    assert_fixed(this.localInstrumentation, ['CORE', 'COR1', 'B2B'], 'localInstrumentation');
    assert_fixed(this.sequenceType, ['FRST', 'RCUR', 'OOFF', 'FNAL'], 'sequenceType');

    if (this.method === PaymentInfoTypes.DirectDebit) {
      assert_date(this.collectionDate, 'collectionDate');
    }
    else {
      assert_date(this.requestedExecutionDate, 'requestedExecutionDate');
    }

    assert_cid(this[pullFrom + 'Id'], pullFrom + 'Id');

    assert_debitor({
      name: this[pullFrom + 'Name'],
      street: this[pullFrom + 'Street'],
      city: this[pullFrom + 'City'],
      country: this[pullFrom + 'Country'],
      iban: this[pullFrom + 'IBAN'],
      bic: this[pullFrom + 'BIC'],
      pullFrom: pullFrom,
    });

    assert_length(this._payments.length, 1, null, '_payments');
  }

  /*
    * Serialize this document to a DOM Element.
    *
    * @return      The DOM <PmtInf> Element.
    */
  toXML(doc) {
    if (VALIDATIONS_ENABLED) {
      this.validate();
    }

    const n = createXMLHelper(doc, true, false);
    //var o = createXMLHelper(doc, false, true);
    const r = createXMLHelper(doc, true, true);
    let pmtInf = doc.createElementNS(doc.documentElement.namespaceURI, 'PmtInf');

    r(pmtInf, 'PmtInfId', this.id);
    r(pmtInf, 'PmtMtd', this.method);
    // XML v3 formats, add grouping + batch booking nodes
    if (getPainXMLVersion(this._painFormat) === 3) {
      r(pmtInf, 'BtchBookg', this.batchBooking.toString());
      r(pmtInf, 'NbOfTxs', this.transactionCount);
      r(pmtInf, 'CtrlSum', this.controlSum.toFixed(2));
    }

    let pmtTpInf = n(pmtInf, 'PmtTpInf');
    // ORDER IS IMPORTANT !
    r(pmtTpInf, 'InstrPrty', this.instructionPriority);
    r(pmtTpInf, 'SvcLvl', 'Cd', 'SEPA');
    if (this.categoryPurpose) {
      r(pmtTpInf, 'CtgyPurp', 'Cd', this.categoryPurpose);
    }

    if (this.method === PaymentInfoTypes.DirectDebit) {
      r(pmtTpInf, 'LclInstrm', 'Cd', this.localInstrumentation);
      r(pmtTpInf, 'SeqTp', this.sequenceType);
      r(pmtInf, 'ReqdColltnDt', this.collectionDate.toISOString().substr(0, 10));
    }
    else {
      r(pmtInf, 'ReqdExctnDt', this.requestedExecutionDate.toISOString().substr(0, 10));
    }

    const pullFrom = this.method === PaymentInfoTypes.DirectDebit ? 'creditor' : 'debtor';
    const emitterNodeName = this.method === PaymentInfoTypes.DirectDebit ? 'Cdtr' : 'Dbtr';
    const emitter = n(pmtInf, emitterNodeName);

    r(emitter, 'Nm', this[pullFrom + 'Name']);
    if (this[pullFrom + 'Street'] && this[pullFrom + 'City'] && this[pullFrom + 'Country']) {
      let pstl = n(emitter, 'PstlAdr');
      r(pstl, 'Ctry', this[pullFrom + 'Country']);
      r(pstl, 'AdrLine', this[pullFrom + 'Street']);
      r(pstl, 'AdrLine', this[pullFrom + 'City']);
    }

    r(pmtInf, emitterNodeName + 'Acct', 'Id', 'IBAN', this[pullFrom + 'IBAN']);
    if (this[pullFrom + 'BIC']) {
      const p = createXMLHelper(doc, true, false);
      let finInstnId = p(pmtInf, emitterNodeName + 'Agt', 'FinInstnId');
      r(finInstnId, 'BIC', this[pullFrom + 'BIC']);
      if (this[pullFrom + 'MemberId']) {
        r(finInstnId, 'ClrSysMmbId', 'MmbId', this[pullFrom + 'MemberId']);
      }
    } else {
      r(pmtInf, emitterNodeName + 'Agt', 'FinInstnId', 'Othr', 'Id', 'NOTPROVIDED');
    }

    r(pmtInf, 'ChrgBr', 'SLEV');

    if (this.method === PaymentInfoTypes.DirectDebit) {
      let creditorScheme = n(pmtInf, 'CdtrSchmeId', 'Id', 'PrvtId', 'Othr');
      r(creditorScheme, 'Id', this.creditorId);
      r(creditorScheme, 'SchmeNm', 'Prtry', 'SEPA');
    }

    for (let i = 0, l = this._payments.length; i < l; ++i) {
      pmtInf.appendChild(this._payments[i].toXML(doc));
    }

    return pmtInf;
  }

  /**
   * Serialize this element to an XML string.
   *
   * @return      The XML string of this element.
   */
  toString() {
    return serializeToString(this.toXML(this));
  }
}

/**
 * Generic Transaction class
 */
const TransactionTypes = {
  DirectDebit: 'DrctDbtTxInf',
  Transfer:    'CdtTrfTxInf'
};

class SepaTransaction {
  static TransactionTypes = TransactionTypes;
  
  _painFormat: string;

  /** Generic Transaction Type */
  _type: string;

  /** The unique transaction id */
  id: string = '';

  /** The End-To-End id */
  end2endId: string = '';

  /** The currency to transfer */
  currency: string = 'EUR';

  /** The amount to transfer */
  amount: number = 0;

  ammendment: string = '';

  /** (optional) The purpose code to use */
  purposeCode: string = null;

  /** The mandate id of the debtor */
  mandateId: string = '';

  /** The signature date of the mandate */
  mandateSignatureDate: Date = null;

  /** Name, Address, IBAN and BIC of the debtor */
  debtorName: string = '';
  debtorStreet: string = null;
  debtorCity: string = null;
  debtorCountry: string = null;
  debtorIBAN: string = '';
  debtorBIC: string = '';

  /** Unstructured Remittance Info */
  remittanceInfo: string = '';

  /** Name, Address, IBAN and BIC of the creditor */
  creditorName: string = '';
  creditorStreet: string = null;
  creditorCity: string = null;
  creditorCountry: string = null
  creditorIBAN: string = '';
  creditorBIC: string = '';

  overrideReference: string;


  constructor(painFormat) {
    this._painFormat = painFormat;
    this._type = painFormat.indexOf('pain.001') === 0 ? TransactionTypes.Transfer : TransactionTypes.DirectDebit;
  }

  
  validate() {
    const pullFrom = this._type === TransactionTypes.Transfer ? 'creditor' : 'debtor';

    assert_sepa_id_set1(this.end2endId, 'end2endId');
    assert_range(this.amount, 0.01, 999999999.99, 'amount');
    if (!(parseInt(this.amount.toString()) == this.amount)) {
      assert(this.amount.toString().split('.')[1].length <= 2, 'amount has too many fractional digits');
    }
    assert_length(this.purposeCode, 1, 4, 'purposeCode');
    assert_sepa_id_set2(this.mandateId, 'mandateId');
    assert_date(this.mandateSignatureDate, 'mandateSignatureDate');

    assert_debitor({
      name: this[pullFrom + 'Name'],
      street: this[pullFrom + 'Street'],
      city: this[pullFrom + 'City'],
      country: this[pullFrom + 'Country'],
      iban: this[pullFrom + 'IBAN'],
      bic: this[pullFrom + 'BIC'],
      pullFrom: pullFrom,
    });

    assert_length(this.remittanceInfo, null, 140, 'remittanceInfo');
  }

  toXML(doc) {
    if (VALIDATIONS_ENABLED) {
      this.validate();
    }

    const pullFrom = this._type === TransactionTypes.Transfer ? 'creditor' : 'debtor';
    const recieverNodeName = this._type === TransactionTypes.Transfer ? 'Cdtr' : 'Dbtr';

    const n = createXMLHelper(doc, true, false);
    const o = createXMLHelper(doc, false, true);
    const r = createXMLHelper(doc, true, true);

    let txInf = doc.createElementNS(doc.documentElement.namespaceURI, this._type);

    let paymentId = n(txInf, 'PmtId');
    r(paymentId, 'InstrId', this.id);
    r(paymentId, 'EndToEndId', this.end2endId);

    if (this._type === TransactionTypes.DirectDebit) {
      r(txInf, 'InstdAmt', this.amount.toFixed(2)).setAttribute('Ccy', this.currency);

      let mandate = n(txInf, 'DrctDbtTx', 'MndtRltdInf');
      r(mandate, 'MndtId', this.mandateId);
      r(mandate, 'DtOfSgntr', this.mandateSignatureDate.toISOString().substr(0, 10));

      if (this.ammendment) {
        r(mandate, 'AmdmntInd', 'true');
        r(mandate, 'AmdmnInfDtls', this.ammendment);
      } else {
        r(mandate, 'AmdmntInd', 'false');
      }
    }
    else {
      r(txInf, 'Amt', 'InstdAmt', this.amount.toFixed(2)).setAttribute('Ccy', this.currency);
    }

    if (this[pullFrom + 'BIC']) {
      r(txInf, recieverNodeName + 'Agt', 'FinInstnId', 'BIC', this[pullFrom + 'BIC']);
    } else {
      r(txInf, recieverNodeName + 'Agt', 'FinInstnId', 'Othr', 'Id', 'NOTPROVIDED');
    }

    let reciever = n(txInf, recieverNodeName);
    r(reciever, 'Nm', this[pullFrom + 'Name']);

    if (this[pullFrom + 'Street'] && this[pullFrom + 'City'] && this[pullFrom + 'Country']) {
      let pstl = n(reciever, 'PstlAdr');
      r(pstl, 'Ctry', this.debtorCountry);
      r(pstl, 'AdrLine', this.debtorStreet);
      r(pstl, 'AdrLine', this.debtorCity);
    }

    r(txInf, recieverNodeName + 'Acct', 'Id', 'IBAN', this[pullFrom + 'IBAN']);

    r(txInf, 'RmtInf', 'Ustrd', this.remittanceInfo);
    o(txInf, 'Purp', 'Cd', this.purposeCode);

    return txInf;
  }
}

/**
 * Replace letters with numbers using the SEPA scheme A=10, B=11, ...
 * Non-alphanumerical characters are dropped.
 *
 * @param str     The alphanumerical input string
 * @return        The input string with letters replaced
 */
function _replaceChars(str) {
  let res = '';
  for (let i = 0, l = str.length; i < l; ++i) {
    const cc = str.charCodeAt(i);
    if (cc >= 65 && cc <= 90) {
      res += (cc - 55).toString();
    } else if (cc >= 97 && cc <= 122) {
      res += (cc - 87).toString();
    } else if (cc >= 48 && cc <= 57) {
      res += str[i];
    }
  }
  return res;
}

/**
 * mod97 function for large numbers
 *
 * @param str     The number as a string.
 * @return        The number mod 97.
 */
function _txtMod97(str) {
  let res = 0;
  for (let i = 0, l = str.length; i < l; ++i) {
    res = (res * 10 + parseInt(str[i], 10)) % 97;
  }
  return res;
}

/**
 * Checks if an IBAN is valid (no country specific checks are done).
 *
 * @param iban        The IBAN to check.
 * @return            True, if the IBAN is valid.
 */
function validateIBAN(iban) {
  const ibrev = iban.substr(4) + iban.substr(0, 4);
  return _txtMod97(_replaceChars(ibrev)) === 1;
}

/**
 * Calculates the checksum for the given IBAN. The input IBAN should pass 00
 * as the checksum digits, a full iban with the corrected checksum will be
 * returned.
 *
 * Example: DE00123456781234567890 -> DE87123456781234567890
 *
 * @param iban        The IBAN to calculate the checksum for.
 * @return            The corrected IBAN.
 */
function checksumIBAN(iban) {
  const ibrev = iban.substr(4) + iban.substr(0, 2) + '00';
  const mod = _txtMod97(_replaceChars(ibrev));
  return iban.substr(0, 2) + ('0' + (98 - mod)).substr(-2,2) + iban.substr(4);
}

/**
 * Checks if a Creditor ID is valid (no country specific checks are done).
 *
 * @param iban        The Creditor ID to check.
 * @return            True, if the Creditor IDis valid.
 */
function validateCreditorID(cid) {
  const cidrev = cid.substr(7) + cid.substr(0, 4);
  return _txtMod97(_replaceChars(cidrev)) === 1;
}

/**
 * Calculates the checksum for the given Creditor ID . The input Creditor ID
 * should pass 00 as the checksum digits, a full Creditor ID with the
 * corrected checksum will be returned.
 *
 * Example: DE00ZZZ09999999999 -> DE98ZZZ09999999999
 *
 * @param iban        The IBAN to calculate the checksum for.
 * @return            The corrected IBAN.
 */
function checksumCreditorID(cid) {
  const cidrev = cid.substr(7) + cid.substr(0, 2) + '00';
  const mod = _txtMod97(_replaceChars(cidrev));
  return cid.substr(0, 2) + ('0' + (98 - mod)).substr(-2,2) + cid.substr(4);
}

// --- Various private functions follow --- //

function assert_debitor({
  name,
  street,
  city,
  country,
  iban,
  bic,
  pullFrom,
}) {
  // contains all the fields that don't respect the sepa norm.
  let message = '';
  const invalidFields = [];
  if (name && name.length > 70) {
    invalidFields.push('name');
    message = 'debitor name is too long.';
  }
  if (street && street.length > 70) {
    invalidFields.push('street');
    message = 'debitor street is too long.';
  }
  if (city && city.length > 70) {
    invalidFields.push('city');
    message = 'debitor city is too long.';
  }
  if (country && country.length > 2) {
    invalidFields.push('country');
    message = 'debitor country is too long.';
  }

  try {
    assert_name(name, pullFrom);
  } catch (error) {
    message = pullFrom + ' has invalid name: "' + name + '"';
    invalidFields.push(pullFrom + 'Name');
  }

  try {
    assert_name(name, pullFrom);
  } catch (error) {
    message = pullFrom + ' has invalid name: "' + name + '"';
    invalidFields.push(pullFrom + 'Name');
  }

  try {
    assert_iban(iban, pullFrom + 'IBAN');
    assert_fixed(bic.length, [0, 8, 11], pullFrom + 'BIC');
    const countryMatches = (bic.length === 0 || bic.substr(4, 2) === iban.substr(0, 2));

    assert(countryMatches, message);
  } catch (err) {
    // FIXME: pullFrom is debtor not debitor.
    message = 'country mismatch in BIC/IBAN for ' + pullFrom + ' called ' + name + ' with BIC: ' + bic + ' and IBAN: ' + iban;
    invalidFields.push('IBAN/BIC');
  }
  if (invalidFields.length > 0) {
    throw new InvalidSupplierError(name, invalidFields, message);
  }
}

/** Assert that |cond| is true, otherwise throw an error with |msg| */
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

/** Assert that |val| is one of |choices| */
function assert_fixed(val, choices, member) {
  if (choices.indexOf(val) < 0) {
    throw new Error(member + ' must have any value of: ' + choices.join(' ') + '(found: ' + val + ')');
  }
}

/** assert that |str| has a length between min and max (either may be null) */
function assert_length(str, min, max, member) {
  if ((min !== null && str && str.length < min) ||
      (max !== null && str && str.length > max)) {
    throw new Error(member + ' has invalid string length, expected ' + min + ' < ' + str + ' < ' + max);
  }
}

/** assert that |num| is in the range between |min| and |max| */
function assert_range(num, min, max, member) {
  if (num < min || num > max) {
    throw new Error(member + ' does not match range ' + min + ' < ' + num + ' < ' + max);
  }
}

/** assert that |str| is an IBAN */
function assert_iban(str,  member) {
  if (!validateIBAN(str)) {
    throw new Error(member + ' has invalid IBAN "' + str + '"');
  }
}

/** assert that |str| is not empty */
function assert_name(str,  member) {
  if (!str || !str.trim().length) {
    throw new Error(member + ' has invalid name: "' + str + '"');
  }
}

/** assert that |str| is a creditor id */
function assert_cid(str, member) {
  if (!validateCreditorID(str)) {
    throw new Error(member + ' is invalid "' + str + '"');
  }
}

/** assert an iso date */
function assert_date(dt, member) {
  if (!dt || isNaN(dt.getTime())) {
    throw new Error(member + ' has invalid date ' + dt);
  }
}

/** assert that the str uses characters from the first sepa id charset */
function assert_sepa_id_set1(str, member) {
  if (str && !str.match(/([A-Za-z0-9]|[+|?|/|\-|:|(|)|.|,|'| ]){1,35}/)) {
    throw new Error(member + ' doesn\'t match sepa id charset type 1 (found: ' + '"' + str + '")');
  }
}

/** assert that the str uses characters from the second sepa id charset */
function assert_sepa_id_set2(str, member) {
  if (str && !str.match(/([A-Za-z0-9]|[+|?|/|\-|:|(|)|.|,|']){1,35}/)) {
    throw new Error(member + ' doesn\'t match sepa id charset type 2 (found: ' + '"' + str + '")');
  }
}

/**
 * Creates a DOM Document, either using the browser document, or node.js xmldom.
 *
 * @param nsURI       The namespace URI.
 * @param qname       Qualified name for the root tag.
 * @return            The created DOM document.
 */
function createDocument(nsURI, qname) {
  if (typeof document !== 'undefined' && typeof document.implementation !== 'undefined') {
    return document.implementation.createDocument(nsURI, qname, null);
  } else {
    const DOMImplementation = require('xmldom').DOMImplementation;
    return new DOMImplementation().createDocument(nsURI, qname);
  }
}

/**
 * Serializes a dom element or document to string, using either the builtin
 * XMLSerializer or the one from node.js xmldom.
 *
 * @param doc         The document or element to serialize
 * @return            The serialized XML document.
 */
function serializeToString(doc) {
  const XMLSerializer = require('xmldom').XMLSerializer;
  const s = new XMLSerializer();
  return s.serializeToString(doc);
}

/**
 * Returns a helper for creating XML nodes. There are three intended calls
 * for this helper. The first parameter for the returned function is always
 * the parent element, followed by a variable number of element names. The
 * last parameter may be the text content value, as shown below. The
 * innermost node is always returned.
 *
 *  // This helper creates a node without a contained value
 *  // Usage: n(rootNode, 'foo', 'bar')
 *  // Result: <root><foo><bar/></foo></root>
 *  var n = createXMLHelper(doc, true, false);
 *
 *  // This helper creates a node with an optional value. If the value is
 *  // null, then the node is not added to the parent.
 *  // Usage: o(rootNode, 'foo', 'bar', myValue)
 *  // Result (if myValue is not null): <root><foo><bar>myValue</bar></foo></root>
 *  var o = createXMLHelper(doc, false, true);
 *
 *  // This helper creates a node with a required value. It is added
 *  // regardless of if its null or not.
 *  // Usage: r(rootNode, 'foo', 'bar', myValue)
 *  // Result: <root><foo><bar>myValue</bar></foo></root>
 *  var r = createXMLHelper(doc, true, true);
 *
 * @param doc         The document to create nodes with
 * @param required    If false, nodes with null values will not be added to the parent.
 * @param withVal     If true, the last parameter of the returned function is set as textContent.
 */
function createXMLHelper(doc, required: boolean, withVal: boolean) {
  return function(...args: any[]) {
    let node = args[0];
    const val = withVal && args[args.length - 1];
    const maxarg = (withVal ? args.length - 1 : args.length);

    if (required || val || val === 0) {
      for (let i = 1; i < maxarg; ++i) {
        node = node.appendChild(doc.createElementNS(doc.documentElement.namespaceURI, args[i]));
      }
      if (withVal) {
        node.textContent = val;
      }
      return node;
    } else {
      return null;
    }
  };
}

const extractABICodeFromIBAN = (iban) => {
  // https://www.money.it/Trovare-codici-ABI-CAB-e-CIN-da
  return iban.substring(5, 10);
};

// --- Module Exports follow --- //
export {
  SepaDocument as Document,
  SepaPaymentInfo as PaymentInfo,
  SepaTransaction as Transaction,
  validateIBAN,
  checksumIBAN,
  validateCreditorID,
  checksumCreditorID,
  setIDSeparator,
  enableValidations,
};

export const CountryHelpers = {
  italy: {
    extractABICodeFromIBAN: extractABICodeFromIBAN
  }
};