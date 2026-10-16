"""Field extraction tests — no Surya, no Tesseract, no Pillow needed.

Every case feeds the kind of line list an OCR engine actually hands back:
text plus a box, where the box height stands in for the font size.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from extract import (  # noqa: E402
    FieldSpec,
    Line,
    UNSURE_BELOW,
    extract_fields,
    find_phones,
    normalise_phone,
    parse_vcard,
    role_of,
    split_name,
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def card(rows: list[tuple[str, int]], confidence: float = 0.9) -> list[Line]:
    """Rows of (text, font size) laid out down the card, like a real read."""
    lines: list[Line] = []
    y = 20.0
    for text, size in rows:
        lines.append(Line(text, (40.0, y, 40.0 + len(text) * size * 0.55, y + size), confidence))
        y += size + 8
    return lines


DEFAULT_FIELDS = [
    FieldSpec("first_name", "First name", "text", (), "", True),
    FieldSpec("last_name", "Last name", "text", (), "", True),
    FieldSpec("company", "Company", "text", (), "Legal company name, without the logo tagline"),
    FieldSpec("job_title", "Job title", "text"),
    FieldSpec("email", "Email", "email"),
    FieldSpec("phone", "Phone", "phone", (), "Prefer the mobile number if there are several"),
    FieldSpec("website", "Website", "link"),
    FieldSpec("country", "Country", "text", (), "Infer from address or phone prefix"),
]


GERMAN = card([
    ("Müller Technik GmbH", 16),
    ("Dr. Anna Schmidt", 22),
    ("Leiterin Vertrieb", 12),
    ("Industriestraße 42", 11),
    ("80339 München", 11),
    ("Deutschland", 11),
    ("Tel. +49 89 1234 56-0", 11),
    ("Mobil +49 151 2345 6789", 11),
    ("a.schmidt@mueller-technik.de", 11),
    ("www.mueller-technik.de", 11),
])

FRENCH = card([
    ("AgriSol SAS", 15),
    ("Camille Dubois", 20),
    ("Directrice commerciale", 12),
    ("12 rue de la Paix", 11),
    ("75002 Paris", 11),
    ("Tél. 01 42 68 53 00", 11),
    ("Port. 06 12 34 56 78", 11),
    ("camille.dubois@agrisol.fr", 11),
    ("www.agrisol.fr", 11),
])

ITALIAN = card([
    ("Semi Verdi S.r.l.", 15),
    ("Marco Bianchi", 20),
    ("Responsabile acquisti", 12),
    ("Via Roma 12", 11),
    ("20121 Milano", 11),
    ("Tel. +39 02 1234 5678", 11),
    ("Cell. +39 347 123 4567", 11),
    ("m.bianchi@semiverdi.it", 11),
    ("semiverdi.it", 11),
])

SPANISH = card([
    ("Cultivos Ibéricos SL", 15),
    ("Lucía Fernández", 20),
    ("Export Manager", 12),
    ("Calle Mayor 3", 11),
    ("28013 Madrid", 11),
    ("España", 11),
    ("Tel: +34 91 234 56 78", 11),
    ("Móvil: +34 612 34 56 78", 11),
    ("lucia@cultivosibericos.es", 11),
])

DUTCH = card([
    ("GroenAgro B.V.", 15),
    ("Sanne de Vries", 20),
    ("Inkoper", 12),
    ("Keizersgracht 123", 11),
    ("1015 CJ Amsterdam", 11),
    ("T +31 20 123 4567", 11),
    ("M +31 6 12345678", 11),
    ("sanne.devries@groenagro.nl", 11),
    ("www.groenagro.nl", 11),
])

PORTUGUESE = card([
    ("TerraViva Lda", 15),
    ("João Pereira", 20),
    ("CEO", 12),
    ("Rua das Flores 45", 11),
    ("1200-192 Lisboa", 11),
    ("Tel. +351 21 123 4567", 11),
    ("Telemóvel +351 912 345 678", 11),
    ("joao.pereira@terraviva.pt", 11),
    ("www.terraviva.pt", 11),
])

BRITISH = card([
    ("Harvest Analytics Ltd", 15),
    ("Emily Carter", 20),
    ("Product Lead", 12),
    ("Tel +44 20 7946 0958", 11),
    ("Mob +44 7700 900123", 11),
    ("emily.carter@harvest-analytics.co.uk", 11),
    ("harvest-analytics.co.uk", 11),
])

# German company, English job title, French address — the show-floor normal.
MIXED = card([
    ("Rheinhaus Logistik GmbH", 15),
    ("Thomas Vogel", 20),
    ("Senior Sales Manager", 12),
    ("Zone Industrielle 8", 11),
    ("67000 Strasbourg", 11),
    ("France", 11),
    ("Mobile: +33 7 55 12 34 56", 11),
    ("t.vogel@rheinhaus.eu", 11),
])


def read(lines: list[Line], fields=None, **kwargs) -> dict:
    return extract_fields(lines, fields or DEFAULT_FIELDS, **kwargs)


# --------------------------------------------------------------------------
# Whole-card cases, one per language
# --------------------------------------------------------------------------


def test_german_card():
    out = read(GERMAN, language="de")
    assert out["first_name"].value == "Anna"          # the "Dr." is not a first name
    assert out["last_name"].value == "Schmidt"
    assert out["company"].value == "Müller Technik GmbH"
    assert out["job_title"].value == "Leiterin Vertrieb"
    assert out["email"].value == "a.schmidt@mueller-technik.de"
    assert out["phone"].value == "+4915123456789"      # the mobile, not the switchboard
    assert out["website"].value == "https://www.mueller-technik.de"
    assert out["country"].value == "Germany"


def test_french_card_local_numbers_become_international():
    out = read(FRENCH, language="fr")
    assert out["first_name"].value == "Camille"
    assert out["last_name"].value == "Dubois"
    assert out["company"].value == "AgriSol SAS"
    assert out["job_title"].value == "Directrice commerciale"
    assert out["phone"].value == "+33612345678"        # "Port. 06 12..." -> E.164 (AI-08)
    assert out["country"].value == "France"


def test_italian_card():
    out = read(ITALIAN, language="it")
    assert out["first_name"].value == "Marco"
    assert out["last_name"].value == "Bianchi"
    assert out["company"].value == "Semi Verdi S.r.l."
    assert out["job_title"].value == "Responsabile acquisti"
    assert out["phone"].value == "+393471234567"
    assert out["website"].value == "https://semiverdi.it"
    assert out["country"].value == "Italy"


def test_spanish_card_guesses_the_website_from_the_email():
    out = read(SPANISH, language="es")
    assert out["first_name"].value == "Lucía"
    assert out["last_name"].value == "Fernández"
    assert out["company"].value == "Cultivos Ibéricos SL"
    assert out["phone"].value == "+34612345678"
    assert out["country"].value == "Spain"
    assert out["website"].value == "https://cultivosibericos.es"
    assert out["website"].confidence < UNSURE_BELOW
    assert "email" in (out["website"].reason or "").lower()


@pytest.mark.parametrize("domain", [
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "ymail.com",
    "outlook.com", "hotmail.com", "hotmail.de", "live.com", "msn.com",
    "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
    "tutanota.com", "gmx.de", "web.de", "t-online.de", "orange.fr", "free.fr",
    "libero.it", "yandex.ru", "mail.ru", "qq.com", "163.com", "naver.com",
    "rediffmail.com", "uol.com.br", "sapo.pt", "zoho.com", "mail.com",
    "bigpond.com", "seznam.cz", "wp.pl", "walla.co.il",
])
def test_public_mailbox_is_never_guessed_as_the_website(domain: str):
    lines = card([
        ("Priya Nair", 34),
        ("Sales Manager", 20),
        (f"priya.nair@{domain}", 20),
        ("+91 98400 12345", 20),
    ])
    out = read(lines, language="en")
    assert out["email"].value == f"priya.nair@{domain}"
    assert "website" not in out, f"no website from {domain}"
    # The name still comes from the card — only the website guess is blocked.
    assert out["first_name"].value == "Priya"
    assert out["last_name"].value == "Nair"


def test_is_free_mail_domain_matches_case_insensitively():
    from extract import is_free_mail_domain
    assert is_free_mail_domain("GMail.COM")
    assert is_free_mail_domain("gmail.com.")
    assert not is_free_mail_domain("nordsaat.de")
    assert not is_free_mail_domain("mygmail.com")  # a company domain, not Google's
    assert not is_free_mail_domain("")


def test_domain_base_and_score():
    from extract import _domain_score, domain_base_of
    assert domain_base_of("enrichspaces.co.in") == "enrichspaces"
    assert domain_base_of("nordsaat.de") == "nordsaat"
    assert domain_base_of("harvestanalytics.co.uk") == "harvestanalytics"
    assert domain_base_of("mail.company.com") == "company"
    assert domain_base_of("invalid") == ""
    assert _domain_score("Enrich Spaces", "enrichspaces") == 1.0
    assert _domain_score("NORDSAAT Saatgut GmbH", "nordsaat") >= 0.8
    assert _domain_score("Ennich Spaces", "enrichspaces") >= 0.55  # one OCR slip
    assert _domain_score("Priya Nair", "enrichspaces") == 0.0


def test_domain_cross_check_resolves_company_without_a_legal_suffix():
    lines = card([
        ("Enrich Spaces", 34),
        ("Preeti Balaraman", 30),
        ("preeti@enrichspaces.co.in", 20),
        ("+91 99406 42190", 20),
    ])
    out = read(lines, language="en")
    assert out["company"].value == "Enrich Spaces"
    assert out["first_name"].value == "Preeti"
    assert out["last_name"].value == "Balaraman"


def test_domain_cross_check_holds_when_the_name_comes_first():
    lines = card([
        ("Preeti Balaraman", 34),
        ("Enrich Spaces", 30),
        ("preeti@enrichspaces.co.in", 20),
        ("+91 99406 42190", 20),
    ])
    out = read(lines, language="en")
    assert out["company"].value == "Enrich Spaces"
    assert out["first_name"].value == "Preeti"
    assert out["last_name"].value == "Balaraman"


def test_person_is_never_stored_as_the_company():
    lines = card([
        ("Priya Nair", 34),
        ("priya.nair@gmail.com", 20),
        ("+91 98400 12345", 20),
    ])
    out = read(lines, language="en")
    assert "company" not in out
    assert out["first_name"].value == "Priya"
    assert out["last_name"].value == "Nair"


def test_company_still_matches_with_one_ocr_slip_in_its_name():
    lines = card([
        ("Ennich Spaces", 34),
        ("Preeti Balaraman", 30),
        ("preeti@enrichspaces.co.in", 20),
        ("+91 99406 42190", 20),
    ])
    out = read(lines, language="en")
    assert out["company"].value == "Ennich Spaces"
    assert out["first_name"].value == "Preeti"
    assert out["last_name"].value == "Balaraman"


def test_printed_website_outranks_the_email_domain():
    lines = card([
        ("Enrich Spaces", 34),
        ("Preeti Balaraman", 30),
        ("preeti@enrichspaces.co.in", 20),
        ("www.enrichspaces.co.in", 20),
        ("+91 99406 42190", 20),
    ])
    out = read(lines, language="en")
    assert out["website"].value == "https://www.enrichspaces.co.in"
    assert out["company"].value == "Enrich Spaces"
    assert out["first_name"].value == "Preeti"
    assert out["last_name"].value == "Balaraman"


def test_website_decides_even_with_a_public_mailbox():
    lines = card([
        ("Enrich Spaces", 34),
        ("Preeti Balaraman", 30),
        ("preeti.balaraman@gmail.com", 20),
        ("www.enrichspaces.co.in", 20),
        ("+91 99406 42190", 20),
    ])
    out = read(lines, language="en")
    assert out["website"].value == "https://www.enrichspaces.co.in"
    assert out["company"].value == "Enrich Spaces"
    assert out["first_name"].value == "Preeti"
    assert out["last_name"].value == "Balaraman"


def test_website_domain_scores_above_the_email_domain():
    from extract import find_company
    lines = card([
        ("Enrich Spaces", 34),
        ("Preeti Balaraman", 30),
        ("preeti@enrichspaces.co.in", 20),
        ("www.enrichspaces.co.in", 20),
        ("+91 99406 42190", 20),
    ])
    used = {2, 3, 4}  # email, website and phone lines, as read_card would mark them
    value, certainty, _, why = find_company(lines, "preeti@enrichspaces.co.in",
                                            "https://www.enrichspaces.co.in", used)
    assert value == "Enrich Spaces"
    assert certainty == 0.9
    assert why == "site-domain-match"
    value, certainty, _, why = find_company(lines, "preeti@enrichspaces.co.in", None, used)
    assert value == "Enrich Spaces"
    assert certainty == 0.85
    assert why == "domain-match"


def test_dutch_card_keeps_the_surname_particle():
    out = read(DUTCH, language="nl")
    assert out["first_name"].value == "Sanne"
    assert out["last_name"].value == "de Vries"        # not "Vries"
    assert out["company"].value == "GroenAgro B.V."
    assert out["phone"].value == "+31612345678"        # the bare "M" prefix is a mobile
    assert out["country"].value == "Netherlands"


def test_portuguese_card():
    out = read(PORTUGUESE, language="pt")
    assert out["first_name"].value == "João"
    assert out["last_name"].value == "Pereira"
    assert out["company"].value == "TerraViva Lda"
    assert out["job_title"].value == "CEO"
    assert out["phone"].value == "+351912345678"
    assert out["country"].value == "Portugal"


def test_british_card():
    out = read(BRITISH, language="en")
    assert out["first_name"].value == "Emily"
    assert out["last_name"].value == "Carter"
    assert out["company"].value == "Harvest Analytics Ltd"
    assert out["job_title"].value == "Product Lead"
    assert out["phone"].value == "+447700900123"
    assert out["country"].value == "United Kingdom"


def test_mixed_language_card():
    """German company, English title, French address and dialling code."""
    out = read(MIXED, language="de")
    assert out["company"].value == "Rheinhaus Logistik GmbH"
    assert out["first_name"].value == "Thomas"
    assert out["last_name"].value == "Vogel"
    assert out["job_title"].value == "Senior Sales Manager"
    assert out["phone"].value == "+33755123456"
    assert out["country"].value == "France"            # printed on the card beats the language


# --------------------------------------------------------------------------
# Phones
# --------------------------------------------------------------------------


def test_fax_is_never_the_phone_number():
    lines = card([
        ("Nordwind Handel GmbH", 15),
        ("Petra Klein", 20),
        ("Fax +49 30 1234 5678", 11),
        ("Tel +49 30 1234 5670", 11),
        ("p.klein@nordwind.de", 11),
    ])
    out = read(lines, language="de")
    assert out["phone"].value == "+493012345670"


def test_two_plain_numbers_ask_the_person_to_check():
    """AI-03: below 0.8 the app shows the reason next to the field."""
    lines = card([
        ("Kontor Nord AB", 15),
        ("Erik Lind", 20),
        ("Tel 08 123 456 78", 11),
        ("Tel 08 987 654 32", 11),
        ("erik@kontornord.se", 11),
    ])
    out = read(lines, language="en")
    assert out["phone"].confidence < UNSURE_BELOW
    assert "mobile" in out["phone"].reason.lower()


def test_phone_without_any_country_hint_keeps_the_digits():
    value, international = normalise_phone("089 1234 560")
    assert not international
    assert not value.startswith("+")
    assert "089" in value


@pytest.mark.parametrize(
    "raw,cc,expected",
    [
        ("+49 89 1234 56-0", "+49", "+49891234560"),
        ("0049 89 123456", None, "+4989123456"),
        ("+49 (0)89 123456", "+49", "+4989123456"),
        ("06 12 34 56 78", "+33", "+33612345678"),
        ("(0) 20 123 4567", "+31", "+31201234567"),
        ("912 345 678", "+351", "+351912345678"),
    ],
)
def test_normalise_phone(raw, cc, expected):
    value, international = normalise_phone(raw, cc)
    assert value == expected
    assert international


def test_find_phones_labels_each_number():
    lines = card([
        ("Tel. +49 89 1234 560", 11),
        ("Fax +49 89 1234 569", 11),
        ("Mobil +49 151 2345 678", 11),
        ("+49 89 9999 111", 11),
    ])
    kinds = [h.kind for h in find_phones(lines)]
    assert kinds == ["phone", "fax", "mobile", "bare"]


# --------------------------------------------------------------------------
# Names
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "full,first,last",
    [
        ("Anna Schmidt", "Anna", "Schmidt"),
        ("Dr. Anna Schmidt", "Anna", "Schmidt"),
        ("Sanne de Vries", "Sanne", "de Vries"),
        ("Ludwig von Habsburg", "Ludwig", "von Habsburg"),
        # "Maria del Carmen" is one Spanish given name; only "Ruiz" is the surname.
        ("Maria del Carmen Ruiz", "Maria del Carmen", "Ruiz"),
        ("João Pereira", "João", "Pereira"),
        ("Carter", "", "Carter"),
    ],
)
def test_split_name(full, first, last):
    assert split_name(full) == (first, last)


def test_name_is_not_the_company_even_when_the_company_is_bigger():
    lines = card([
        ("NORDLICHT LOGISTIK GMBH", 26),   # the logo line, the biggest on the card
        ("Jonas Weber", 15),
        ("j.weber@nordlicht-logistik.de", 10),
    ])
    out = read(lines, language="de")
    assert out["first_name"].value == "Jonas"
    assert out["last_name"].value == "Weber"
    assert out["company"].value == "NORDLICHT LOGISTIK GMBH"


def test_name_falls_back_to_the_biggest_line_and_says_so():
    lines = card([
        ("Bureau Lemaire", 14),
        ("Claire Moreau", 21),
        ("info@bureau-lemaire.fr", 10),     # no personal email to confirm the name
    ])
    out = read(lines, language="fr")
    assert out["first_name"].value == "Claire"
    assert out["last_name"].value == "Moreau"
    assert out["first_name"].confidence < UNSURE_BELOW
    assert out["first_name"].reason


# --------------------------------------------------------------------------
# Company
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line_text",
    [
        "Weber Maschinenbau GmbH & Co. KG",
        "Atelier Roux SARL",
        "Officine Bruno S.p.A.",
        "Transportes Vega S.L.",
        "Van Dijk Techniek B.V.",
        "Quinta Nova Lda",
        "Severn Instruments Ltd",
        "Kontor Nord AB",
    ],
)
def test_legal_suffix_wins_the_company_field(line_text):
    lines = card([
        ("A Tagline That Means Nothing", 18),
        (line_text, 12),
        ("Petra Klein", 16),
        ("p.klein@example.com", 10),
    ])
    out = read(lines)
    assert out["company"].value == line_text
    assert out["company"].confidence >= UNSURE_BELOW


def test_company_from_the_domain_when_there_is_no_legal_suffix():
    lines = card([
        ("Blauwasser Consulting", 16),
        ("Nina Roth", 20),
        ("n.roth@blauwasser.de", 11),
        ("www.blauwasser.de", 11),
    ])
    out = read(lines, language="de")
    assert out["company"].value == "Blauwasser Consulting"


# --------------------------------------------------------------------------
# Custom fields, choices and QR codes
# --------------------------------------------------------------------------


def test_unknown_custom_field_is_matched_on_its_label():
    fields = [FieldSpec("booth", "Stand", "text"), FieldSpec("email", "Email", "email")]
    lines = card([
        ("Semi Verdi S.r.l.", 15),
        ("Marco Bianchi", 20),
        ("Stand: B4-217", 11),
        ("m.bianchi@semiverdi.it", 11),
    ])
    out = extract_fields(lines, fields, language="it")
    assert out["booth"].value == "B4-217"
    assert out["booth"].reason                     # a label match is never a sure thing


def test_choice_field_matches_one_of_its_options():
    fields = [FieldSpec("product_interest", "Product interest", "choice", ("Seeds", "Machinery", "Fertiliser"))]
    lines = card([
        ("Feldtechnik GmbH", 15),
        ("Machinery for arable farming", 11),
        ("l.schneider@feldtechnik.de", 11),
    ])
    out = extract_fields(lines, fields, language="de")
    assert out["product_interest"].value == "Machinery"


def test_ai_hint_nudges_an_unknown_key():
    """The key means nothing to us, but the hint names what to look for."""
    fields = [FieldSpec("f_042", "Ref", "text", (), "the mobile phone number")]
    lines = card([
        ("Feldtechnik GmbH", 15),
        ("Lukas Schneider", 20),
        ("Mobil +49 151 2345 6789", 11),
        ("l.schneider@feldtechnik.de", 11),
    ])
    out = extract_fields(lines, fields, language="de")
    assert out["f_042"].value == "+4915123456789"


def test_qr_vcard_beats_the_heuristics():
    vcard = (
        "BEGIN:VCARD\r\n"
        "VERSION:3.0\r\n"
        "N:Schmidt;Anna;;Dr.;\r\n"
        "FN:Anna Schmidt\r\n"
        "ORG:Müller Technik GmbH\r\n"
        "TITLE:Leiterin Vertrieb\r\n"
        "EMAIL;TYPE=WORK:anna.schmidt@mueller-technik.de\r\n"
        "TEL;TYPE=WORK,VOICE:+49 89 1234 560\r\n"
        "TEL;TYPE=CELL:+49 151 2345 6789\r\n"
        "URL:https://mueller-technik.de\r\n"
        "END:VCARD\r\n"
    )
    # The printed email is misread by OCR; the QR is not.
    lines = card([
        ("Müller Technik GmbH", 16),
        ("Dr. Anna Schmidt", 22),
        ("a.schrnidt@rnueller-technik.de", 11),
    ])
    out = read(lines, language="de", qr=vcard)
    assert out["email"].value == "anna.schmidt@mueller-technik.de"
    assert out["email"].confidence > 0.9
    assert out["phone"].value == "+4915123456789"      # the CELL entry, not the desk
    assert out["company"].value == "Müller Technik GmbH"


def test_qr_holding_only_a_url():
    assert parse_vcard("https://terraviva.pt")["website"] == "https://terraviva.pt"
    assert parse_vcard("www.terraviva.pt")["website"] == "https://www.terraviva.pt"


# --------------------------------------------------------------------------
# Field roles and the contract
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spec,expected",
    [
        (FieldSpec("first_name", "First name"), "first_name"),
        (FieldSpec("vorname", "Vorname"), "first_name"),
        (FieldSpec("achternaam", "Achternaam"), "last_name"),
        (FieldSpec("x1", "E-mail", "email"), "email"),
        (FieldSpec("x2", "Site web", "link"), "website"),
        (FieldSpec("x3", "Telefono", "phone"), "phone"),
        (FieldSpec("x4", "Azienda"), "company"),
        (FieldSpec("x5", "Cargo"), "job_title"),
        (FieldSpec("x6", "Pays"), "country"),
        (FieldSpec("zzz", "Badge colour"), "unknown"),
    ],
)
def test_role_of(spec, expected):
    assert role_of(spec) == expected


def test_every_answer_below_the_threshold_carries_a_reason():
    """AI-03 — the app only has something to show when we set it."""
    for lines in (GERMAN, FRENCH, ITALIAN, SPANISH, DUTCH, PORTUGUESE, BRITISH, MIXED):
        for key, value in read(lines).items():
            assert 0.0 < value.confidence <= 1.0, key
            if value.confidence < UNSURE_BELOW:
                assert value.reason, f"{key} is unsure but says nothing"
            else:
                assert value.reason is None, f"{key} is confident but still explains itself"


def test_no_field_comes_back_empty():
    for lines in (GERMAN, FRENCH, ITALIAN, SPANISH, DUTCH, PORTUGUESE, BRITISH, MIXED):
        for key, value in read(lines).items():
            assert value.value.strip(), key


def test_a_blank_card_answers_nothing_rather_than_guessing():
    assert read(card([("", 10)])) == {}
    assert read([]) == {}


def test_only_the_asked_for_fields_come_back():
    out = read(GERMAN, fields=[FieldSpec("email", "Email", "email")])
    assert list(out) == ["email"]


# --------------------------------------------------------------------------
# Surya's HTML blocks -> lines with boxes
#
# engines.py only pulls in Pillow/Surya inside the functions that need them,
# so this part is testable with nothing installed.
# --------------------------------------------------------------------------

import engines  # noqa: E402


class FakeBox:
    def __init__(self, bbox, confidence=0.9):
        self.bbox = bbox
        self.confidence = confidence


class FakeBlock:
    def __init__(self, html, bbox, reading_order=0, skipped=False, error=False, confidence=0.9):
        self.html = html
        self.bbox = bbox
        self.reading_order = reading_order
        self.skipped = skipped
        self.error = error
        self.confidence = confidence


class FakePage:
    def __init__(self, blocks):
        self.blocks = blocks


def test_block_lines_take_the_detected_boxes_when_the_counts_agree():
    page = FakePage([FakeBlock("<p>Müller Technik GmbH</p><p>Anna Schmidt</p>", [10, 10, 300, 60])])
    boxes = [FakeBox([12, 12, 280, 30], 0.95), FakeBox([12, 34, 250, 58], 0.91)]
    lines = engines._lines_from_blocks(page, boxes)
    assert [l.text for l in lines] == ["Müller Technik GmbH", "Anna Schmidt"]
    assert lines[0].bbox == (12.0, 12.0, 280.0, 30.0)
    assert lines[1].confidence == pytest.approx(0.91)


def test_block_lines_fall_back_to_slicing_the_block():
    page = FakePage([FakeBlock("A<br>B<br>C", [0, 0, 100, 30])])
    lines = engines._lines_from_blocks(page, [])          # detection gave us nothing
    assert [l.text for l in lines] == ["A", "B", "C"]
    assert [l.bbox[1] for l in lines] == [0.0, 10.0, 20.0]


def test_block_lines_skip_logos_and_unescape_entities():
    page = FakePage([
        FakeBlock("<p>logo</p>", [0, 0, 50, 10], reading_order=0, skipped=True),
        FakeBlock("<p>Schmidt &amp; Sohn GmbH</p>", [0, 20, 200, 40], reading_order=1),
    ])
    lines = engines._lines_from_blocks(page, [])
    assert [l.text for l in lines] == ["Schmidt & Sohn GmbH"]


def test_blocks_feed_straight_into_the_field_extraction():
    page = FakePage([
        FakeBlock("<p>GroenAgro B.V.</p>", [20, 10, 240, 34], reading_order=0),
        FakeBlock("<p>Sanne de Vries</p>", [20, 44, 260, 76], reading_order=1),
        FakeBlock("<p>M +31 6 12345678</p><p>sanne.devries@groenagro.nl</p>", [20, 86, 300, 126], reading_order=2),
    ])
    out = extract_fields(engines._lines_from_blocks(page, []), DEFAULT_FIELDS, language="nl")
    assert out["company"].value == "GroenAgro B.V."
    assert out["first_name"].value == "Sanne"
    assert out["last_name"].value == "de Vries"
    assert out["phone"].value == "+31612345678"
