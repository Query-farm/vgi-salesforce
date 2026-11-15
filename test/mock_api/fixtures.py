"""Fixture org for the Salesforce replay server: describes and records built from documented shapes.

Objects: Account, Contact, Opportunity, Case, Lead, User, Task, Invoice__c (custom, with a
namespaced managed-package field, a base64 field and tied SystemModstamps across pages),
plus the metadata objects Profile, UserRole, PermissionSet, PermissionSetAssignment,
RecordType and Organization. Every id carries a correct 18-character checksum.
"""

SUFFIX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"


def checksum(id15):
    out = ""
    for block in range(3):
        bits = 0
        for i in range(5):
            c = id15[block * 5 + i]
            if "A" <= c <= "Z":
                bits |= 1 << i
        out += SUFFIX[bits]
    return out


def sfid(prefix, n):
    """An 18-character id: prefix + 'Dn' pod marker + zero-padded number."""
    base = f"{prefix}Dn{n:010d}"
    return base + checksum(base)


# ----------------------------------------------------------------- field builders

def F(name, type_, label=None, **kw):
    soap = {
        "id": "tns:ID", "reference": "tns:ID", "boolean": "xsd:boolean", "int": "xsd:int", "long": "xsd:long",
        "double": "xsd:double", "currency": "xsd:double", "percent": "xsd:double", "date": "xsd:date",
        "datetime": "xsd:dateTime", "time": "xsd:time", "base64": "xsd:base64Binary", "address": "urn:address",
        "location": "urn:location", "anyType": "xsd:anyType",
    }.get(type_, "xsd:string")
    f = {
        "name": name, "label": label or name.replace("__c", "").replace("_", " "), "type": type_, "soapType": soap,
        "length": kw.pop("length", 255 if type_ in ("string", "picklist", "url", "email", "phone", "textarea", "multipicklist", "combobox") else 0),
        "precision": kw.pop("precision", 0), "scale": kw.pop("scale", 0), "digits": 9 if type_ == "int" else 0,
        "nillable": kw.pop("nillable", type_ not in ("id", "boolean")),
        "createable": type_ not in ("id",), "updateable": type_ not in ("id",),
        "filterable": kw.pop("filterable", type_ not in ("address", "location", "textarea", "base64")),
        "sortable": type_ not in ("multipicklist", "textarea", "address", "location", "base64"),
        "groupable": type_ in ("id", "reference", "string", "picklist", "boolean", "date", "int"),
        "custom": name.endswith("__c") or name.endswith("__s"),
        "calculated": kw.pop("calculated", False), "calculatedFormula": kw.pop("formula", None),
        "referenceTo": kw.pop("referenceTo", []), "relationshipName": kw.pop("relationshipName", None),
        "compoundFieldName": kw.pop("compound", None), "picklistValues": [],
    }
    pv = kw.pop("values", None)
    if pv:
        f["picklistValues"] = [
            {"value": v, "label": v, "active": not v.startswith("Old"), "defaultValue": i == 0, "validFor": None}
            for i, v in enumerate(pv)
        ]
    assert not kw, kw
    return f


def ref(name, target, rel):
    return F(name, "reference", referenceTo=target if isinstance(target, list) else [target], relationshipName=rel)


def address(prefix, label):
    """A standard compound address and its components."""
    comp = f"{prefix}Address"
    return [
        F(f"{prefix}Street", "textarea", compound=comp, filterable=True),
        F(f"{prefix}City", "string", compound=comp),
        F(f"{prefix}State", "string", compound=comp),
        F(f"{prefix}PostalCode", "string", compound=comp),
        F(f"{prefix}Country", "string", compound=comp),
        F(f"{prefix}Latitude", "double", precision=18, scale=15, compound=comp),
        F(f"{prefix}Longitude", "double", precision=18, scale=15, compound=comp),
        F(f"{prefix}GeocodeAccuracy", "picklist", compound=comp, values=["Address", "City", "Zip"]),
        F(comp, "address", label),
    ]


SYSTEM = lambda: [  # noqa: E731
    F("IsDeleted", "boolean"),
    ref("OwnerId", ["User"], "Owner"),
    F("CreatedDate", "datetime"),
    F("LastModifiedDate", "datetime"),
    F("SystemModstamp", "datetime"),
]

DESCRIBE_FIELDS = {
    "Account": [
        F("Id", "id"), *SYSTEM(), F("Name", "string"),
        F("Type", "picklist", values=["Customer", "Prospect", "Partner", "Old Reseller"]),
        ref("ParentId", "Account", "Parent"), F("Industry", "picklist", values=["Technology", "Manufacturing", "Energy", "Retail"]),
        F("AnnualRevenue", "currency", precision=18, scale=0), F("NumberOfEmployees", "int"),
        F("Phone", "phone"), F("Website", "url"), F("Rating", "picklist", values=["Hot", "Warm", "Cold"]),
        *address("Billing", "Billing Address"),
        F("Tier__c", "picklist", "Tier", values=["Gold", "Silver", "Bronze"]),
        F("Regions__c", "multipicklist", "Regions", values=["AMER", "EMEA", "APAC"]),
        F("Acme__Score__c", "double", "Score (Acme package)", precision=5, scale=1),
        F("HQ_Location__Latitude__s", "double", precision=3, scale=6, compound="HQ_Location__c"),
        F("HQ_Location__Longitude__s", "double", precision=3, scale=6, compound="HQ_Location__c"),
        F("HQ_Location__c", "location", "HQ Location"),
        F("Owner__c", "string", "Owner (text)"),
    ],
    "Contact": [
        F("Id", "id"), *SYSTEM(), ref("AccountId", "Account", "Account"), F("FirstName", "string"),
        F("LastName", "string"), F("Name", "string"), F("Email", "email"), F("Title", "string"),
        F("Birthdate", "date"), F("HasOptedOutOfEmail", "boolean"), F("MailingCity", "string"),
    ],
    "Opportunity": [
        F("Id", "id"), *SYSTEM(), ref("AccountId", "Account", "Account"), F("Name", "string"),
        F("StageName", "picklist", values=["Prospecting", "Qualification", "Negotiation", "Closed Won", "Closed Lost"]),
        F("Amount", "currency", precision=16, scale=2), F("Probability", "percent", precision=3, scale=0),
        F("CloseDate", "date"), F("IsClosed", "boolean"), F("IsWon", "boolean"),
        F("Type", "picklist", values=["New Business", "Renewal", "Upsell"]),
        F("LeadSource", "picklist", values=["Web", "Partner", "Event"]),
        F("ForecastCategoryName", "picklist", values=["Pipeline", "Best Case", "Commit", "Closed", "Omitted"]),
        F("ExpectedRevenue", "currency", precision=16, scale=2, calculated=True, formula="Amount * Probability"),
        F("Discount_Pct__c", "percent", "Discount %", precision=5, scale=2),
    ],
    "Case": [
        F("Id", "id"), *SYSTEM(), F("CaseNumber", "string"), F("Subject", "string"),
        F("Status", "picklist", values=["New", "Working", "Escalated", "Closed"]),
        F("Priority", "picklist", values=["High", "Medium", "Low"]), ref("AccountId", "Account", "Account"),
        ref("ContactId", "Contact", "Contact"), F("IsClosed", "boolean"), F("ClosedDate", "datetime"),
    ],
    "Lead": [
        F("Id", "id"), *SYSTEM(), F("FirstName", "string"), F("LastName", "string"), F("Name", "string"),
        F("Company", "string"), F("Status", "picklist", values=["Open", "Working", "Converted", "Disqualified"]),
        F("Email", "email"), F("LeadSource", "picklist", values=["Web", "Partner", "Event"]),
        F("IsConverted", "boolean"), F("AnnualRevenue", "currency", precision=18, scale=0),
    ],
    "User": [
        F("Id", "id"), F("CreatedDate", "datetime"), F("SystemModstamp", "datetime"), F("Username", "string"),
        F("Name", "string"), F("Alias", "string"), F("Email", "email"), F("IsActive", "boolean"),
        F("UserType", "picklist", values=["Standard", "PowerPartner", "CsnOnly"]),
        ref("ProfileId", "Profile", "Profile"), ref("UserRoleId", "UserRole", "UserRole"), F("LastLoginDate", "datetime"),
    ],
    "Task": [
        F("Id", "id"), *SYSTEM(), F("Subject", "string"),
        ref("WhatId", ["Account", "Opportunity", "Invoice__c"], "What"), ref("WhoId", ["Contact", "Lead"], "Who"),
        F("Status", "picklist", values=["Not Started", "Completed"]), F("ActivityDate", "date"),
    ],
    "Invoice__c": [
        F("Id", "id"), *SYSTEM(), F("Name", "string", "Invoice Number"),
        ref("Account__c", "Account", "Account__r"), F("Amount__c", "currency", "Amount", precision=18, scale=2),
        F("Status__c", "picklist", "Status", values=["Draft", "Sent", "Paid", "Void"]),
        F("Issued_On__c", "date", "Issued On"), F("Paid__c", "boolean", "Paid"),
        F("Line_Count__c", "double", "Line Count", precision=18, scale=0),
        F("Notes__c", "textarea", "Notes"), F("Acme__Region__c", "string", "Region (Acme package)"),
        F("Due_Time__c", "time", "Due Time"), F("Pdf_Body__c", "base64", "PDF Body"),
    ],
    "Profile": [F("Id", "id"), F("Name", "string"), ref("UserLicenseId", "UserLicense", "UserLicense"),
                F("UserType", "picklist"), F("Description", "textarea")],
    "UserLicense": [F("Id", "id"), F("Name", "string")],
    "UserRole": [F("Id", "id"), F("Name", "string")],
    "PermissionSet": [F("Id", "id"), F("Name", "string"), F("Label", "string"), F("IsOwnedByProfile", "boolean"),
                      F("IsCustom", "boolean"), F("Description", "textarea")],
    "PermissionSetAssignment": [F("Id", "id"), ref("PermissionSetId", "PermissionSet", "PermissionSet"),
                                ref("AssigneeId", "User", "Assignee")],
    "RecordType": [F("Id", "id"), F("SobjectType", "picklist"), F("DeveloperName", "string"), F("Name", "string"),
                   F("Description", "string"), F("IsActive", "boolean")],
    "Organization": [F("Id", "id"), F("Name", "string"), F("OrganizationType", "picklist"), F("InstanceName", "string"),
                     F("IsSandbox", "boolean"), F("NamespacePrefix", "string"), F("DefaultLocaleSidKey", "picklist"),
                     F("TimeZoneSidKey", "picklist"), F("LanguageLocaleKey", "picklist"), F("CreatedDate", "datetime")],
}

PREFIX = {
    "Account": "001", "Contact": "003", "Opportunity": "006", "Case": "500", "Lead": "00Q", "User": "005",
    "Task": "00T", "Invoice__c": "a0X", "Profile": "00e", "UserLicense": "100", "UserRole": "00E",
    "PermissionSet": "0PS", "PermissionSetAssignment": "0Pa", "RecordType": "012", "Organization": "00D",
}

# ------------------------------------------------------------------------ records

U1, U2, U3 = sfid("005", 1), sfid("005", 2), sfid("005", 3)
A = [sfid("001", i) for i in range(1, 6)]
C = [sfid("003", i) for i in range(1, 7)]
O = [sfid("006", i) for i in range(1, 9)]
INV = [sfid("a0X", i) for i in range(1, 8)]


def ts(s):
    return s  # stored as ISO "YYYY-MM-DDThh:mm:ss.sssZ"


def sysf(i, base="2026-01-0{}T09:00:00.000Z"):
    return {"IsDeleted": False, "OwnerId": [U1, U2][i % 2], "CreatedDate": "2025-06-01T12:00:00.000Z",
            "LastModifiedDate": base.format(i + 1), "SystemModstamp": base.format(i + 1)}


RECORDS = {
    "User": [
        {"Id": U1, "Username": "ada@acme.example", "Name": "Ada Lovelace", "Alias": "ada", "Email": "ada@acme.example",
         "IsActive": True, "UserType": "Standard", "ProfileId": sfid("00e", 1), "UserRoleId": sfid("00E", 1),
         "LastLoginDate": "2026-01-10T08:00:00.000Z", "CreatedDate": "2024-01-01T00:00:00.000Z", "SystemModstamp": "2026-01-10T08:00:00.000Z"},
        {"Id": U2, "Username": "grace@acme.example", "Name": "Grace Hopper", "Alias": "grace", "Email": "grace@acme.example",
         "IsActive": True, "UserType": "Standard", "ProfileId": sfid("00e", 2), "UserRoleId": sfid("00E", 2),
         "LastLoginDate": "2026-01-09T08:00:00.000Z", "CreatedDate": "2024-02-01T00:00:00.000Z", "SystemModstamp": "2026-01-09T08:00:00.000Z"},
        {"Id": U3, "Username": "old@acme.example", "Name": "Old Integration", "Alias": "oldi", "Email": "old@acme.example",
         "IsActive": False, "UserType": "Standard", "ProfileId": sfid("00e", 2), "UserRoleId": None,
         "LastLoginDate": None, "CreatedDate": "2023-01-01T00:00:00.000Z", "SystemModstamp": "2023-06-01T00:00:00.000Z"},
    ],
    "Profile": [
        {"Id": sfid("00e", 1), "Name": "System Administrator", "UserLicenseId": sfid("100", 1), "UserType": "Standard", "Description": None},
        {"Id": sfid("00e", 2), "Name": "Sales User", "UserLicenseId": sfid("100", 1), "UserType": "Standard", "Description": "Sales reps"},
        {"Id": sfid("00e", 3), "Name": "Read Only", "UserLicenseId": sfid("100", 1), "UserType": "Standard", "Description": None},
    ],
    "UserLicense": [{"Id": sfid("100", 1), "Name": "Salesforce"}],
    "UserRole": [{"Id": sfid("00E", 1), "Name": "CEO"}, {"Id": sfid("00E", 2), "Name": "Sales Rep"}],
    "PermissionSet": [
        {"Id": sfid("0PS", 1), "Name": "API_Only", "Label": "API Only", "IsOwnedByProfile": False, "IsCustom": True, "Description": "Integration access"},
        {"Id": sfid("0PS", 2), "Name": "Sales_Ops", "Label": "Sales Ops", "IsOwnedByProfile": False, "IsCustom": True, "Description": None},
        {"Id": sfid("0PS", 3), "Name": "X00ex000000", "Label": "Profile-owned", "IsOwnedByProfile": True, "IsCustom": False, "Description": None},
    ],
    "PermissionSetAssignment": [
        {"Id": sfid("0Pa", 1), "PermissionSetId": sfid("0PS", 1), "AssigneeId": U1},
        {"Id": sfid("0Pa", 2), "PermissionSetId": sfid("0PS", 2), "AssigneeId": U1},
        {"Id": sfid("0Pa", 3), "PermissionSetId": sfid("0PS", 2), "AssigneeId": U2},
        {"Id": sfid("0Pa", 4), "PermissionSetId": sfid("0PS", 3), "AssigneeId": U2},
    ],
    "RecordType": [
        {"Id": sfid("012", 1), "SobjectType": "Account", "DeveloperName": "Customer", "Name": "Customer Account", "Description": None, "IsActive": True},
        {"Id": sfid("012", 2), "SobjectType": "Account", "DeveloperName": "Partner", "Name": "Partner Account", "Description": None, "IsActive": True},
        {"Id": sfid("012", 3), "SobjectType": "Opportunity", "DeveloperName": "Legacy", "Name": "Legacy Deal", "Description": "Pre-2020", "IsActive": False},
    ],
    "Organization": [
        {"Id": sfid("00D", 1), "Name": "Acme Fixture Org", "OrganizationType": "Developer Edition", "InstanceName": "NA224",
         "IsSandbox": False, "NamespacePrefix": None, "DefaultLocaleSidKey": "en_US", "TimeZoneSidKey": "America/Los_Angeles",
         "LanguageLocaleKey": "en_US", "CreatedDate": "2024-01-01T00:00:00.000Z"},
    ],
    "Account": [
        {"Id": A[0], **sysf(0), "Name": "Acme Corp", "Type": "Customer", "ParentId": None, "Industry": "Technology",
         "AnnualRevenue": 12500000, "NumberOfEmployees": 1200, "Phone": "+1 415 555 0100", "Website": "https://acme.example",
         "Rating": "Hot", "BillingStreet": "1 Market St", "BillingCity": "San Francisco", "BillingState": "CA",
         "BillingPostalCode": "94105", "BillingCountry": "USA", "BillingLatitude": 37.7936, "BillingLongitude": -122.3958,
         "BillingGeocodeAccuracy": "Address", "Tier__c": "Gold", "Regions__c": "AMER;EMEA", "Acme__Score__c": 92.5,
         "HQ_Location__Latitude__s": 37.7936, "HQ_Location__Longitude__s": -122.3958, "Owner__c": "Ada"},
        {"Id": A[1], **sysf(1), "Name": "Globex", "Type": "Prospect", "ParentId": None, "Industry": "Manufacturing",
         "AnnualRevenue": 830000, "NumberOfEmployees": 85, "Phone": None, "Website": None, "Rating": "Warm",
         "BillingStreet": None, "BillingCity": "Springfield", "BillingState": "IL", "BillingPostalCode": None,
         "BillingCountry": "USA", "BillingLatitude": None, "BillingLongitude": None, "BillingGeocodeAccuracy": None,
         "Tier__c": "Silver", "Regions__c": "AMER", "Acme__Score__c": 61.0, "HQ_Location__Latitude__s": None,
         "HQ_Location__Longitude__s": None, "Owner__c": None},
        {"Id": A[2], **sysf(2), "Name": "Initech", "Type": "Customer", "ParentId": A[0], "Industry": "Technology",
         "AnnualRevenue": 4300000, "NumberOfEmployees": 410, "Phone": "+1 512 555 0199", "Website": "https://initech.example",
         "Rating": "Cold", "BillingStreet": "4120 Freidrich Ln", "BillingCity": "Austin", "BillingState": "TX",
         "BillingPostalCode": "78744", "BillingCountry": "USA", "BillingLatitude": 30.2, "BillingLongitude": -97.75,
         "BillingGeocodeAccuracy": "Zip", "Tier__c": "Bronze", "Regions__c": None, "Acme__Score__c": 40.2,
         "HQ_Location__Latitude__s": None, "HQ_Location__Longitude__s": None, "Owner__c": None},
        {"Id": A[3], **sysf(3), "Name": "Umbrella", "Type": "Partner", "ParentId": None, "Industry": "Energy",
         "AnnualRevenue": None, "NumberOfEmployees": None, "Phone": None, "Website": None, "Rating": None,
         "BillingStreet": None, "BillingCity": "London", "BillingState": None, "BillingPostalCode": None,
         "BillingCountry": "UK", "BillingLatitude": None, "BillingLongitude": None, "BillingGeocodeAccuracy": None,
         "Tier__c": None, "Regions__c": "EMEA;APAC", "Acme__Score__c": None, "HQ_Location__Latitude__s": 51.5,
         "HQ_Location__Longitude__s": -0.12, "Owner__c": None},
        {"Id": A[4], **sysf(4), "Name": "O'Malley & Sons", "Type": "Customer", "ParentId": None, "Industry": "Retail",
         "AnnualRevenue": 150000, "NumberOfEmployees": 12, "Phone": None, "Website": None, "Rating": "Warm",
         "BillingStreet": None, "BillingCity": "Dublin", "BillingState": None, "BillingPostalCode": None,
         "BillingCountry": "Ireland", "BillingLatitude": None, "BillingLongitude": None, "BillingGeocodeAccuracy": None,
         "Tier__c": "Bronze", "Regions__c": "EMEA", "Acme__Score__c": 55.5, "HQ_Location__Latitude__s": None,
         "HQ_Location__Longitude__s": None, "Owner__c": None},
    ],
    "Contact": [
        {"Id": C[0], **sysf(0), "AccountId": A[0], "FirstName": "Wile", "LastName": "Coyote", "Name": "Wile Coyote",
         "Email": "wile@acme.example", "Title": "CTO", "Birthdate": "1980-03-14", "HasOptedOutOfEmail": False, "MailingCity": "San Francisco"},
        {"Id": C[1], **sysf(1), "AccountId": A[0], "FirstName": "Road", "LastName": "Runner", "Name": "Road Runner",
         "Email": "road@acme.example", "Title": "VP Sales", "Birthdate": None, "HasOptedOutOfEmail": True, "MailingCity": None},
        {"Id": C[2], **sysf(2), "AccountId": A[1], "FirstName": "Hank", "LastName": "Scorpio", "Name": "Hank Scorpio",
         "Email": "hank@globex.example", "Title": "CEO", "Birthdate": "1970-01-01", "HasOptedOutOfEmail": False, "MailingCity": "Springfield"},
        {"Id": C[3], **sysf(3), "AccountId": A[2], "FirstName": "Peter", "LastName": "Gibbons", "Name": "Peter Gibbons",
         "Email": None, "Title": "Engineer", "Birthdate": None, "HasOptedOutOfEmail": False, "MailingCity": "Austin"},
        {"Id": C[4], **sysf(4), "AccountId": None, "FirstName": "Jane", "LastName": "Doe", "Name": "Jane Doe",
         "Email": "jane@example.org", "Title": None, "Birthdate": None, "HasOptedOutOfEmail": False, "MailingCity": None},
        {"Id": C[5], **sysf(5), "AccountId": A[4], "FirstName": "Seamus", "LastName": "O'Malley", "Name": "Seamus O'Malley",
         "Email": "seamus@omalley.example", "Title": "Owner", "Birthdate": None, "HasOptedOutOfEmail": False, "MailingCity": "Dublin"},
    ],
    "Opportunity": [
        {"Id": O[0], **sysf(0), "AccountId": A[0], "Name": "Acme Platform", "StageName": "Closed Won", "Amount": 250000.00,
         "Probability": 100, "CloseDate": "2026-01-15", "IsClosed": True, "IsWon": True, "Type": "New Business",
         "LeadSource": "Web", "ForecastCategoryName": "Closed", "ExpectedRevenue": 250000.00, "Discount_Pct__c": 12.50},
        {"Id": O[1], **sysf(1), "AccountId": A[0], "Name": "Acme Renewal", "StageName": "Negotiation", "Amount": 120000.50,
         "Probability": 70, "CloseDate": "2026-03-31", "IsClosed": False, "IsWon": False, "Type": "Renewal",
         "LeadSource": None, "ForecastCategoryName": "Commit", "ExpectedRevenue": 84000.35, "Discount_Pct__c": None},
        {"Id": O[2], **sysf(2), "AccountId": A[1], "Name": "Globex Pilot", "StageName": "Prospecting", "Amount": 15000.00,
         "Probability": 10, "CloseDate": "2026-06-30", "IsClosed": False, "IsWon": False, "Type": "New Business",
         "LeadSource": "Event", "ForecastCategoryName": "Pipeline", "ExpectedRevenue": 1500.00, "Discount_Pct__c": 5.00},
        {"Id": O[3], **sysf(3), "AccountId": A[2], "Name": "Initech TPS", "StageName": "Closed Lost", "Amount": 42000.00,
         "Probability": 0, "CloseDate": "2025-11-20", "IsClosed": True, "IsWon": False, "Type": "Upsell",
         "LeadSource": "Partner", "ForecastCategoryName": "Omitted", "ExpectedRevenue": 0.00, "Discount_Pct__c": None},
        {"Id": O[4], **sysf(4), "AccountId": A[2], "Name": "Initech Expansion", "StageName": "Qualification", "Amount": 99000.99,
         "Probability": 20, "CloseDate": "2026-04-15", "IsClosed": False, "IsWon": False, "Type": "Upsell",
         "LeadSource": "Web", "ForecastCategoryName": "Pipeline", "ExpectedRevenue": 19800.20, "Discount_Pct__c": 0.75},
        {"Id": O[5], **sysf(5), "AccountId": A[4], "Name": "O'Malley POS", "StageName": "Closed Won", "Amount": 8000.00,
         "Probability": 100, "CloseDate": "2025-12-01", "IsClosed": True, "IsWon": True, "Type": "New Business",
         "LeadSource": "Web", "ForecastCategoryName": "Closed", "ExpectedRevenue": 8000.00, "Discount_Pct__c": None},
        {"Id": O[6], **sysf(6), "AccountId": None, "Name": "Orphan Deal", "StageName": "Prospecting", "Amount": None,
         "Probability": 10, "CloseDate": "2026-09-01", "IsClosed": False, "IsWon": False, "Type": None,
         "LeadSource": None, "ForecastCategoryName": "Pipeline", "ExpectedRevenue": None, "Discount_Pct__c": None},
        {"Id": O[7], **sysf(7), "AccountId": A[3], "Name": "umbrella grid", "StageName": "Negotiation", "Amount": 310000.00,
         "Probability": 60, "CloseDate": "2026-02-28", "IsClosed": False, "IsWon": False, "Type": "New Business",
         "LeadSource": "Partner", "ForecastCategoryName": "Best Case", "ExpectedRevenue": 186000.00, "Discount_Pct__c": 3.25},
    ],
    "Case": [
        {"Id": sfid("500", 1), **sysf(0), "CaseNumber": "00001001", "Subject": "Login broken", "Status": "Escalated",
         "Priority": "High", "AccountId": A[0], "ContactId": C[0], "IsClosed": False, "ClosedDate": None},
        {"Id": sfid("500", 2), **sysf(1), "CaseNumber": "00001002", "Subject": "Invoice question", "Status": "Closed",
         "Priority": "Low", "AccountId": A[1], "ContactId": C[2], "IsClosed": True, "ClosedDate": "2026-01-05T10:30:00.000Z"},
        {"Id": sfid("500", 3), **sysf(2), "CaseNumber": "00001003", "Subject": "TPS reports", "Status": "Working",
         "Priority": "Medium", "AccountId": A[2], "ContactId": C[3], "IsClosed": False, "ClosedDate": None},
        {"Id": sfid("500", 4), **sysf(3), "CaseNumber": "00001004", "Subject": "Feature request", "Status": "New",
         "Priority": "Low", "AccountId": A[0], "ContactId": None, "IsClosed": False, "ClosedDate": None},
    ],
    "Lead": [
        {"Id": sfid("00Q", 1), **sysf(0), "FirstName": "Lisa", "LastName": "Simpson", "Name": "Lisa Simpson",
         "Company": "Springfield Elementary", "Status": "Open", "Email": "lisa@example.org", "LeadSource": "Web",
         "IsConverted": False, "AnnualRevenue": None},
        {"Id": sfid("00Q", 2), **sysf(1), "FirstName": "Monty", "LastName": "Burns", "Name": "Monty Burns",
         "Company": "Springfield Nuclear", "Status": "Working", "Email": "monty@example.org", "LeadSource": "Event",
         "IsConverted": False, "AnnualRevenue": 900000000},
        {"Id": sfid("00Q", 3), **sysf(2), "FirstName": "Ned", "LastName": "Flanders", "Name": "Ned Flanders",
         "Company": "Leftorium", "Status": "Converted", "Email": None, "LeadSource": "Partner",
         "IsConverted": True, "AnnualRevenue": 50000},
    ],
    "Task": [
        {"Id": sfid("00T", 1), **sysf(0), "Subject": "Kickoff call", "WhatId": O[0], "WhoId": C[0], "Status": "Completed", "ActivityDate": "2026-01-02"},
        {"Id": sfid("00T", 2), **sysf(1), "Subject": "Send contract", "WhatId": O[1], "WhoId": C[1], "Status": "Not Started", "ActivityDate": "2026-02-01"},
        {"Id": sfid("00T", 3), **sysf(2), "Subject": "Account review", "WhatId": A[1], "WhoId": None, "Status": "Not Started", "ActivityDate": None},
        {"Id": sfid("00T", 4), **sysf(3), "Subject": "Chase invoice", "WhatId": INV[0], "WhoId": sfid("00Q", 1), "Status": "Completed", "ActivityDate": "2026-01-20"},
    ],
    # Seven invoices. Three share SystemModstamp 2026-01-05T09:00:00.000Z and two share
    # 2026-01-07T09:00:00.000Z, so with a page size of 2 a tie always straddles a page boundary.
    "Invoice__c": [
        {"Id": INV[0], "IsDeleted": False, "OwnerId": U1, "CreatedDate": "2025-12-01T00:00:00.000Z",
         "LastModifiedDate": "2026-01-03T09:00:00.000Z", "SystemModstamp": "2026-01-03T09:00:00.000Z", "Name": "INV-0001",
         "Account__c": A[0], "Amount__c": 1000.00, "Status__c": "Paid", "Issued_On__c": "2025-12-01", "Paid__c": True,
         "Line_Count__c": 3, "Notes__c": "Net 30\nThanks!", "Acme__Region__c": "West", "Due_Time__c": "17:00:00.000Z", "Pdf_Body__c": "JVBERi0="},
        {"Id": INV[1], "IsDeleted": False, "OwnerId": U1, "CreatedDate": "2025-12-02T00:00:00.000Z",
         "LastModifiedDate": "2026-01-05T09:00:00.000Z", "SystemModstamp": "2026-01-05T09:00:00.000Z", "Name": "INV-0002",
         "Account__c": A[0], "Amount__c": 2500.50, "Status__c": "Sent", "Issued_On__c": "2025-12-02", "Paid__c": False,
         "Line_Count__c": 1, "Notes__c": "Quote \"rush\", please", "Acme__Region__c": "West", "Due_Time__c": None, "Pdf_Body__c": None},
        {"Id": INV[2], "IsDeleted": False, "OwnerId": U2, "CreatedDate": "2025-12-03T00:00:00.000Z",
         "LastModifiedDate": "2026-01-05T09:00:00.000Z", "SystemModstamp": "2026-01-05T09:00:00.000Z", "Name": "INV-0003",
         "Account__c": A[1], "Amount__c": 99.99, "Status__c": "Draft", "Issued_On__c": None, "Paid__c": False,
         "Line_Count__c": 12, "Notes__c": None, "Acme__Region__c": "Central", "Due_Time__c": None, "Pdf_Body__c": None},
        {"Id": INV[3], "IsDeleted": False, "OwnerId": U2, "CreatedDate": "2025-12-04T00:00:00.000Z",
         "LastModifiedDate": "2026-01-05T09:00:00.000Z", "SystemModstamp": "2026-01-05T09:00:00.000Z", "Name": "INV-0004",
         "Account__c": A[2], "Amount__c": 4300.00, "Status__c": "Sent", "Issued_On__c": "2025-12-04", "Paid__c": False,
         "Line_Count__c": 4, "Notes__c": None, "Acme__Region__c": "South", "Due_Time__c": None, "Pdf_Body__c": None},
        {"Id": INV[4], "IsDeleted": False, "OwnerId": U1, "CreatedDate": "2025-12-05T00:00:00.000Z",
         "LastModifiedDate": "2026-01-07T09:00:00.000Z", "SystemModstamp": "2026-01-07T09:00:00.000Z", "Name": "INV-0005",
         "Account__c": A[4], "Amount__c": 150.00, "Status__c": "Void", "Issued_On__c": "2025-12-05", "Paid__c": False,
         "Line_Count__c": 1, "Notes__c": None, "Acme__Region__c": None, "Due_Time__c": None, "Pdf_Body__c": None},
        {"Id": INV[5], "IsDeleted": False, "OwnerId": U1, "CreatedDate": "2025-12-06T00:00:00.000Z",
         "LastModifiedDate": "2026-01-07T09:00:00.000Z", "SystemModstamp": "2026-01-07T09:00:00.000Z", "Name": "INV-0006",
         "Account__c": A[3], "Amount__c": 77000.00, "Status__c": "Paid", "Issued_On__c": "2025-12-06", "Paid__c": True,
         "Line_Count__c": 40, "Notes__c": None, "Acme__Region__c": "EMEA", "Due_Time__c": None, "Pdf_Body__c": None},
        {"Id": INV[6], "IsDeleted": True, "OwnerId": U2, "CreatedDate": "2025-12-07T00:00:00.000Z",
         "LastModifiedDate": "2026-01-08T09:00:00.000Z", "SystemModstamp": "2026-01-08T09:00:00.000Z", "Name": "INV-0007",
         "Account__c": A[0], "Amount__c": 10.00, "Status__c": "Draft", "Issued_On__c": None, "Paid__c": False,
         "Line_Count__c": 1, "Notes__c": None, "Acme__Region__c": None, "Due_Time__c": None, "Pdf_Body__c": None},
    ],
}

# getUpdated / getDeleted answers (by object).
UPDATED = {"Opportunity": [O[1], O[4]], "Account": [A[0]]}
DELETED = {"Opportunity": [{"id": sfid("006", 99), "deletedDate": "2026-01-06T12:00:00.000+0000"}]}
EARLIEST_DELETED = "2025-12-20T00:00:00.000+0000"


def synthetic(n_objects, wide_fields=900):
    """A synthetic large org for the Gate 0 schema spike: N custom objects, one 900-field object."""
    fields, records = {}, {}
    for i in range(1, n_objects + 1):
        name = f"Synth_{i:04d}__c"
        fs = [F("Id", "id"), *SYSTEM(), F("Name", "string")]
        fs += [F(f"Field_{j:02d}__c", ["string", "double", "date", "boolean", "picklist"][j % 5], precision=18 if j % 5 == 1 else 0, scale=2 if j % 5 == 1 else 0) for j in range(1, 21)]
        fields[name] = fs
        PREFIX[name] = f"a{i:02X}"[:3].ljust(3, "0")
        records[name] = []
    wide = [F("Id", "id"), *SYSTEM(), F("Name", "string")]
    types = ["string", "double", "date", "boolean", "picklist", "currency", "datetime", "textarea", "int", "percent"]
    for j in range(1, wide_fields + 1):
        t = types[j % len(types)]
        wide.append(F(f"Wide_Field_{j:03d}__c", t, f"Wide field {j}", precision=18 if t in ("double", "currency", "percent") else 0,
                      scale=2 if t in ("double", "currency", "percent") else 0,
                      values=["A", "B", "C"] if t == "picklist" else None))
    fields["Wide__c"] = wide
    PREFIX["Wide__c"] = "a99"
    records["Wide__c"] = [
        {"Id": sfid("a99", k), **sysf(k % 7), "Name": f"W-{k}", **{f"Wide_Field_{j:03d}__c": None for j in range(1, wide_fields + 1)}}
        for k in range(1, 4)
    ]
    return fields, records
