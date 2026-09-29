# API Info

### Overview

OncoKB™ data can be accessed through the OncoKB™ REST API. The full interactive API reference is available on the [Swagger page](https://www.oncokb.org/swagger-ui/index.html).

### Authentication

Send your OncoKB™ API token in the `Authorization` request header:

```
Authorization: Bearer [your token]
```

Your token is available in [Account Settings](https://www.oncokb.org/account/settings) after your account is approved. If you do not see a token, then follow instructions on the page to request API access.

See the [Data Access page](https://www.oncokb.org/dataAccess) for account and license information.

{% hint style="warning" %}
An API token identifies your OncoKB account and determines which licensed data your requests can access. Keep the token private, do not include it in public code repositories or share it with others.
{% endhint %}

### Instances

| Instance                        | Authentication | Use case                                                              |
| ------------------------------- | -------------- | --------------------------------------------------------------------- |
| `https://www.oncokb.org`        | Required       | Production use and the complete OncoKB™ data                          |
| `https://public.api.oncokb.org` | Not required   | Public API access across all genes, excluding therapeutic data        |
| `https://demo.oncokb.org`       | Not required   | Trial and integration testing with full data for BRAF, TP53, and ROS1 |

All instances use the latest OncoKB™ data version. See [OncoKB News](https://www.oncokb.org/news) for data release notes.

### Endpoint Quick Reference

{% hint style="success" icon="lightbulb" %}
Annotation endpoints support both `GET` and `POST`. Use `GET` for one-off queries and `POST` for batch annotation.
{% endhint %}

#### Somatic Annotation

| Method         | Endpoint                                     | Primary input                                                                                                   |
| -------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET` / `POST` | `/api/v1/annotate/mutations/byProteinChange` | Gene and protein change                                                                                         |
| `GET` / `POST` | `/api/v1/annotate/mutations/byGenomicChange` | TCGA MAF-style genomic location                                                                                 |
| `GET` / `POST` | `/api/v1/annotate/mutations/byHGVSg`         | HGVS genomic expression                                                                                         |
| `GET` / `POST` | `/api/v1/annotate/copyNumberAlterations`     | Gene and copy number alteration type                                                                            |
| `GET` / `POST` | `/api/v1/annotate/structuralVariants`        | Use this endpoint for fusion annotation when you have a gene pair, or for other structural variant annotations. |

#### Germline Annotation

| Method         | Endpoint                                              | Primary input                   |
| -------------- | ----------------------------------------------------- | ------------------------------- |
| `GET` / `POST` | `/api/v1/annotate/germline/mutations/byGenomicChange` | TCGA MAF-style genomic location |
| `GET` / `POST` | `/api/v1/annotate/germline/mutations/byHGVSg`         | HGVS genomic expression         |
| `GET` / `POST` | `/api/v1/annotate/germline/mutations/byHGVSc`         | HGVS coding DNA expression      |

### Common Parameters

The same parameter names are used across many annotation endpoints. Endpoint-specific tables below this section show which parameters are accepted and whether they are required for that endpoint.

| Parameter         | Description                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `referenceGenome` | Reference genome build. Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                                                                                               |
| `tumorType`       | See [OncoTree](https://oncotree.mskcc.org/) for available tumor types. The field supports OncoTree code, OncoTree name (subtype), and OncoTree main type. Example values include `MEL` or `Melanoma` |
| `hugoSymbol`      | HUGO gene symbol. When an endpoint accepts gene identifiers, provide either `hugoSymbol` or `entrezGeneId`. If both are provided, then `entrezGeneId` takes priority. Example: `BRAF`.               |
| `entrezGeneId`    | Entrez gene ID. Use this instead of `hugoSymbol` when you prefer a numeric gene identifier. Example: `673` for BRAF.                                                                                 |
| `consequence`     | Sequence ontology [consequence](http://useast.ensembl.org/info/genome/variation/prediction/predicted_data.html). Example: `missense_variant`                                                         |
| `genomicLocation` | TCGA MAF-style genomic location in `chromosome,start,end,ref,var` format. Example: `7,140453136,140453136,A,T`.                                                                                      |
| `hgvsg`           | [HGVS](https://hgvs-nomenclature.org/stable/) genomic expression. Example: `7:g.140453136A>T`.                                                                                                       |
| `hgvsc`           | [HGVS](https://hgvs-nomenclature.org/stable/) coding DNA expression. Example: `EGFR:c.2369C>T`.                                                                                                      |

### Somatic Annotation Endpoints

{% hint style="warning" %}
For germline variants, use the `/api/v1/annotate/germline/...` endpoints instead of the somatic `/api/v1/annotate/...` endpoints. API users should determine whether each queried variant is somatic or germline and choose the corresponding endpoint. If the origin of a variant is unknown, users can call both the somatic and germline endpoints.

The existing annotation endpoints do not include `/somatic` in the URL because OncoKB was a somatic knowledge base until the recent release of germline, and we preserved the original URL structure to avoid breaking existing workflows.
{% endhint %}

#### Annotate Mutations by Protein Change

`GET https://www.oncokb.org/api/v1/annotate/mutations/byProteinChange`

Use this endpoint when you have a gene and protein-level alteration, including atypical alterations.

| Parameter         | Required    | Type    | Description                                                                                                                                   |
| ----------------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `hugoSymbol`      | Conditional | string  | Required if `entrezGeneId` is not provided. Example: `BRAF`.                                                                                  |
| `entrezGeneId`    | Conditional | integer | Required if `hugoSymbol` is not provided. Example: `673`.                                                                                     |
| `alteration`      | No          | string  | Protein change, supported atypical alteration, or umbrella term. Example: `V600E`, `Truncating Mutations`, `TMB-H`                            |
| `referenceGenome` | No          | string  | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                                                                |
| `consequence`     | No          | string  | Sequence ontology [consequence](http://useast.ensembl.org/info/genome/variation/prediction/predicted_data.html). Example: `missense_variant`. |
| `proteinStart`    | No          | integer | Protein start position. Example: `600`.                                                                                                       |
| `proteinEnd`      | No          | integer | Protein end position. Example: `600`.                                                                                                         |
| `tumorType`       | No          | string  | See [Common Parameters](#common-parameters). Example: `Melanoma`.                                                                             |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/mutations/byProteinChange?hugoSymbol=BRAF&alteration=V600E&tumorType=Melanoma" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Demo:

```bash
curl -X GET "https://demo.oncokb.org/api/v1/annotate/mutations/byProteinChange?hugoSymbol=BRAF&alteration=V600E&tumorType=Melanoma" \
  -H "accept: application/json"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/mutations/byProteinChange" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "gene": { "hugoSymbol": "BRAF" },
      "alteration": "V600E",
      "tumorType": "Melanoma"
    }
  ]'
```

**Atypical Alterations**

Use the somatic protein change endpoint for atypical alterations. Examples of atypical alterations, but not limited to:

| Gene         | Queryable Alteration Value                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AR`         | [v567es](https://www.oncokb.org/gene/AR/somatic/V567ES)                                                                                                                                              |
| `AR`         | [V7](https://www.oncokb.org/gene/AR/somatic/V7) (previously annotated as `AR-V7`)                                                                                                                    |
| `EGFR`       | [vII](https://www.oncokb.org/gene/EGFR/somatic/vII), [vIII](https://www.oncokb.org/gene/EGFR/somatic/vIII), [vV](https://www.oncokb.org/gene/EGFR/somatic/vV) (variant isoforms)                     |
| `EGFR`       | [C-terminal domain](https://www.oncokb.org/gene/EGFR/somatic/C-terminal%20domain) or [CTD](https://www.oncokb.org/gene/EGFR/somatic/CTD)                                                             |
| `FLT3`       | [Internal Tandem Duplication](https://www.oncokb.org/gene/FLT3/somatic/Internal%20Tandem%20Duplication) or [ITD](https://www.oncokb.org/gene/FLT3/somatic/ITD)                                       |
| `BCOR`       | [Internal Tandem Duplication](https://www.oncokb.org/gene/BCOR/somatic/Internal%20Tandem%20Duplication) or [ITD](https://www.oncokb.org/gene/BCOR/somatic/ITD)                                       |
| `UBTF`       | [Internal Tandem Duplication](https://www.oncokb.org/gene/UBTF/somatic/Internal%20Tandem%20Duplication) or [ITD](https://www.oncokb.org/gene/UBTF/somatic/ITD)                                       |
| `EGFR`       | [Kinase Domain Duplication](https://www.oncokb.org/gene/EGFR/somatic/Kinase%20Domain%20Duplication) or [KDD](https://www.oncokb.org/gene/EGFR/somatic/KDD)                                           |
| `BRAF`       | [Kinase Domain Duplication](https://www.oncokb.org/gene/BRAF/somatic/Kinase%20Domain%20Duplication) or [KDD](https://www.oncokb.org/gene/BRAF/somatic/KDD)                                           |
| `FGFR1`      | [Kinase Domain Duplication](https://www.oncokb.org/gene/FGFR1/somatic/Kinase%20Domain%20Duplication) or [KDD](https://www.oncokb.org/gene/FGFR1/somatic/KDD)                                         |
| `MET`        | [Kinase Domain Duplication](https://www.oncokb.org/gene/MET/somatic/Kinase%20Domain%20Duplication) or [KDD](https://www.oncokb.org/gene/MET/somatic/KDD)                                             |
| Not required | [Tumor Mutational Burden-High](https://www.oncokb.org/gene/Other%20Biomarkers/somatic/Tumor%20Mutational%20Burden-High) or [TMB-H](https://www.oncokb.org/gene/Other%20Biomarkers/somatic/TMB-H)     |
| Not required | [Microsatellite Instability-High](https://www.oncokb.org/gene/Other%20Biomarkers/somatic/Microsatellite%20Instability-High) or [MSI-H](https://www.oncokb.org/gene/Other%20Biomarkers/somatic/MSI-H) |

Examples:

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/mutations/byProteinChange?hugoSymbol=EGFR&alteration=vIII" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/mutations/byProteinChange?alteration=MSI-H" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

#### Annotate Mutations by Genomic Change

`GET https://www.oncokb.org/api/v1/annotate/mutations/byGenomicChange`

Use this endpoint when you have chromosome, start, end, reference allele, and variant allele.

| Parameter         | Required | Type   | Description                                                                                                     |
| ----------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `genomicLocation` | Yes      | string | TCGA MAF-style genomic location in `chromosome,start,end,ref,var` format. Example: `7,140453136,140453136,A,T`. |
| `referenceGenome` | No       | string | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                                  |
| `tumorType`       | No       | string | See [Common Parameters](#common-parameters).                                                                    |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/mutations/byGenomicChange?genomicLocation=7%2C140453136%2C140453136%2CA%2CT&tumorType=Melanoma" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/mutations/byGenomicChange" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "genomicLocation": "7,140453136,140453136,A,T",
      "tumorType": "Melanoma"
    }
  ]'
```

#### Annotate Mutations by HGVSg

`GET https://www.oncokb.org/api/v1/annotate/mutations/byHGVSg`

Use this endpoint when you have an HGVS genomic expression.

| Parameter         | Required | Type   | Description                                                                                    |
| ----------------- | -------- | ------ | ---------------------------------------------------------------------------------------------- |
| `hgvsg`           | Yes      | string | [HGVS](https://hgvs-nomenclature.org/stable/) genomic expression. Example: `7:g.140453136A>T`. |
| `referenceGenome` | No       | string | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                 |
| `tumorType`       | No       | string | See [Common Parameters](#common-parameters).                                                   |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/mutations/byHGVSg?hgvsg=7%3Ag.140453136A%3ET&tumorType=Melanoma" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/mutations/byHGVSg" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "hgvsg": "7:g.140453136A>T",
      "tumorType": "Melanoma"
    }
  ]'
```

#### Annotate Copy Number Alterations

`GET https://www.oncokb.org/api/v1/annotate/copyNumberAlterations`

| Parameter                | Required    | Type    | Description                                                    |
| ------------------------ | ----------- | ------- | -------------------------------------------------------------- |
| `hugoSymbol`             | Conditional | string  | Required if `entrezGeneId` is not provided. Example: `BRAF`.   |
| `entrezGeneId`           | Conditional | integer | Required if `hugoSymbol` is not provided. Example: `673`.      |
| `copyNameAlterationType` | Yes         | string  | One of `AMPLIFICATION`, `DELETION`, `GAIN`, `LOSS`.            |
| `referenceGenome`        | No          | string  | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`. |
| `tumorType`              | No          | string  | See [Common Parameters](#common-parameters).                   |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/copyNumberAlterations?hugoSymbol=BRAF&copyNameAlterationType=AMPLIFICATION&tumorType=MEL" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/copyNumberAlterations" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "gene": { "hugoSymbol": "BRAF" },
      "copyNameAlterationType": "AMPLIFICATION",
      "tumorType": "Melanoma"
    }
  ]'
```

#### Annotate Structural Variants

`GET https://www.oncokb.org/api/v1/annotate/structuralVariants`

Use this endpoint for fusion annotation when you have a gene pair, or for other structural variant annotations.

| Parameter               | Required | Type    | Description                                                                                                                                                                   |
| ----------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hugoSymbolA`           | No       | string  | First gene symbol                                                                                                                                                             |
| `entrezGeneIdA`         | No       | integer | First Entrez gene ID. Not required when `hugoSymbolA` is passed                                                                                                               |
| `hugoSymbolB`           | No       | string  | <p>Second gene symbol.<br>For intragenic events, this field can be omitted or set to the same as <code>hugoSymbolA</code>.<br>For fusions, specify the gene partner here.</p> |
| `entrezGeneIdB`         | No       | integer | Second Entrez gene ID. Not required when `hugoSymbolB` is passed                                                                                                              |
| `structuralVariantType` | Yes      | string  | One of `DELETION`, `TRANSLOCATION`, `DUPLICATION`, `INSERTION`, `INVERSION`, `FUSION`, `UNKNOWN`.                                                                             |
| `isFunctionalFusion`    | Yes      | boolean | Whether the event is a functional fusion. Set to true when annotating fusions.                                                                                                |
| `referenceGenome`       | No       | string  | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                                                                                                |
| `tumorType`             | No       | string  | See [Common Parameters](#common-parameters).                                                                                                                                  |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/structuralVariants?hugoSymbolA=CD74&hugoSymbolB=ROS1&structuralVariantType=FUSION&isFunctionalFusion=true&tumorType=Lung%20Adenocarcinoma" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/structuralVariants" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "geneA": { "hugoSymbol": "CD74" },
      "geneB": { "hugoSymbol": "ROS1" },
      "structuralVariantType": "FUSION",
      "functionalFusion": true,
      "tumorType": "Lung Adenocarcinoma"
    }
  ]'
```

### Germline Annotation Endpoints

#### Annotate Germline Mutations by Genomic Change

`GET https://www.oncokb.org/api/v1/annotate/germline/mutations/byGenomicChange`

| Parameter         | Required | Type   | Description                                                                                                     |
| ----------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `genomicLocation` | Yes      | string | TCGA MAF-style genomic location in `chromosome,start,end,ref,var` format. Example: `7,140453136,140453136,A,T`. |
| `referenceGenome` | No       | string | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                                  |
| `tumorType`       | No       | string | See [Common Parameters](#common-parameters).                                                                    |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/germline/mutations/byGenomicChange?genomicLocation=7%2C140453136%2C140453136%2CA%2CT&tumorType=Melanoma" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/germline/mutations/byGenomicChange" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "genomicLocation": "7,140453136,140453136,A,T",
      "tumorType": "Melanoma"
    }
  ]'
```

#### Annotate Germline Mutations by HGVSg

`GET https://www.oncokb.org/api/v1/annotate/germline/mutations/byHGVSg`

| Parameter         | Required | Type   | Description                                                                                    |
| ----------------- | -------- | ------ | ---------------------------------------------------------------------------------------------- |
| `hgvsg`           | Yes      | string | [HGVS](https://hgvs-nomenclature.org/stable/) genomic expression. Example: `7:g.140453136A>T`. |
| `referenceGenome` | No       | string | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                 |
| `tumorType`       | No       | string | See [Common Parameters](#common-parameters).                                                   |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/germline/mutations/byHGVSg?hgvsg=7%3Ag.140453136A%3ET&tumorType=Melanoma" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/germline/mutations/byHGVSg" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "hgvsg": "7:g.140453136A>T",
      "tumorType": "Melanoma"
    }
  ]'
```

#### Annotate Germline Mutations by HGVSc

`GET https://www.oncokb.org/api/v1/annotate/germline/mutations/byHGVSc`

| Parameter         | Required | Type   | Description                                                                                     |
| ----------------- | -------- | ------ | ----------------------------------------------------------------------------------------------- |
| `hgvsc`           | Yes      | string | [HGVS](https://hgvs-nomenclature.org/stable/) coding DNA expression. Example: `EGFR:c.2369C>T`. |
| `referenceGenome` | No       | string | Supported values are `GRCh37` and `GRCh38`. Default: `GRCh37`.                                  |
| `tumorType`       | No       | string | See [Common Parameters](#common-parameters).                                                    |

```bash
curl -X GET "https://www.oncokb.org/api/v1/annotate/germline/mutations/byHGVSc?hgvsc=EGFR%3Ac.2369C%3ET" \
  -H "accept: application/json" \
  -H "Authorization: Bearer [your token]"
```

Batch request:

```bash
curl -X POST "https://www.oncokb.org/api/v1/annotate/germline/mutations/byHGVSc" \
  -H "accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your token]" \
  -d '[
    {
      "referenceGenome": "GRCh37",
      "hgvsc": "EGFR%3Ac.2369C%3ET",
    }
  ]'
```

#### Annotate Germline Mutations by HGVSp (Protein Change)

{% hint style="danger" %}
We currently do not support germline annotation by protein change because a single protein change can correspond to multiple cDNA or genomic changes, and those differences may affect interpretation. We are actively working through how to support this with clear disambiguation.
{% endhint %}

### Common Use Cases

| Use case                                | Example request                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missense mutation in an oncogene        | `https://demo.oncokb.org/api/v1/annotate/mutations/byProteinChange?hugoSymbol=BRAF&alteration=V600E&tumorType=Melanoma`                                                             |
| Missense mutation in a tumor suppressor | `https://demo.oncokb.org/api/v1/annotate/mutations/byProteinChange?hugoSymbol=TP53&alteration=R273C&tumorType=Colon%20Adenocarcinoma`                                               |
| In-frame deletion                       | `https://demo.oncokb.org/api/v1/annotate/mutations/byProteinChange?hugoSymbol=BRAF&alteration=N486_P490del&tumorType=Histiocytosis`                                                 |
| Fusion                                  | `https://demo.oncokb.org/api/v1/annotate/structuralVariants?hugoSymbolA=CD74&hugoSymbolB=ROS1&structuralVariantType=FUSION&isFunctionalFusion=true&tumorType=Lung%20Adenocarcinoma` |

### Important Notes

* For CDKN2A isoforms, use the following values for the `hugoSymbol` parameter:

  ```
  CDKN2A (p14)  → queries p14
  CDKN2A        → queries p16
  ```

  When no isoform suffix is provided, `CDKN2A` defaults to p16.

### Notes and Changelog

* The `evidenceType` parameter is deprecated and not recommended for use. It was marked deprecated as of OncoKB software version `v3.24.0` (December 19, 2024) and may be removed in a future release.

### Annotating MAF/VCF

For MAF files, use the [OncoKB Annotator](https://github.com/oncokb/oncokb-annotator). The OncoKB Annotator is a Python command-line script that wraps the OncoKB REST API and streamlines annotation of MAF files. It handles reading input variants, calling the appropriate OncoKB annotation endpoints, and writing annotated MAF output.

Since OncoKB Annotator only supports MAF files, one option is to use [genome-nexus/vcf2maf-lite](https://github.com/genome-nexus/vcf2maf-lite).