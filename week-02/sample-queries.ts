export type PropertyFilters = {
  city: string | null;
  maxPrice: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  type: string | null;
  pool: "True" | null;
  hasView: "True" | null;
};

export const sampleQueries: { query: string; expected: PropertyFilters }[] = [
  {
    query: "Show me 3-bedroom condos in Irvine under $1.5M with a pool.",
    expected: {
      city: "Irvine",
      maxPrice: 1_500_000,
      beds: 3,
      baths: null,
      sqft: null,
      type: "Condominium",
      pool: "True",
      hasView: null,
    },
  },
  {
    query: "townhomes in Newport Beach under $2M with a view",
    expected: {
      city: "Newport Beach",
      maxPrice: 2_000_000,
      beds: null,
      baths: null,
      sqft: null,
      type: "Townhouse",
      pool: null,
      hasView: "True",
    },
  },
  {
    query: "single family in Pasadena under 900k at least 1800 sqft",
    expected: {
      city: "Pasadena",
      maxPrice: 900_000,
      beds: null,
      baths: null,
      sqft: 1800,
      type: "SingleFamilyResidence",
      pool: null,
      hasView: null,
    },
  },
  {
    query: "2.5 bath condos in San Diego under $800,000",
    expected: {
      city: "San Diego",
      maxPrice: 800_000,
      beds: null,
      baths: 2.5,
      sqft: null,
      type: "Condominium",
      pool: null,
      hasView: null,
    },
  },
  {
    query: "homes in Irvine",
    expected: {
      city: "Irvine",
      maxPrice: null,
      beds: null,
      baths: null,
      sqft: null,
      type: null,
      pool: null,
      hasView: null,
    },
  },
  {
    query: "land in Riverside under 500k",
    expected: {
      city: "Riverside",
      maxPrice: 500_000,
      beds: null,
      baths: null,
      sqft: null,
      type: "UnimprovedLand",
      pool: null,
      hasView: null,
    },
  },
  {
    query: "at least 3 bedrooms and 2 bathrooms in San Jose",
    expected: {
      city: "San Jose",
      maxPrice: null,
      beds: 3,
      baths: 2,
      sqft: null,
      type: null,
      pool: null,
      hasView: null,
    },
  },
  {
    query: "4 bed 3 bath single family in Irvine with pool and ocean view, 2500 sq ft, under 2.5M",
    expected: {
      city: "Irvine",
      maxPrice: 2_500_000,
      beds: 4,
      baths: 3,
      sqft: 2500,
      type: "SingleFamilyResidence",
      pool: "True",
      hasView: "True",
    },
  },
  {
    query: "condos in Costa Mesa under $1,200,000 with 2 beds and a pool",
    expected: {
      city: "Costa Mesa",
      maxPrice: 1_200_000,
      beds: 2,
      baths: null,
      sqft: null,
      type: "Condominium",
      pool: "True",
      hasView: null,
    },
  },
  {
    query: "3-bedroom townhomes in Long Beach under $750k with a view",
    expected: {
      city: "Long Beach",
      maxPrice: 750_000,
      beds: 3,
      baths: null,
      sqft: null,
      type: "Townhouse",
      pool: null,
      hasView: "True",
    },
  },
  {
    query: "single family in Sacramento under 650k with 4 bedrooms and 2.5 baths",
    expected: {
      city: "Sacramento",
      maxPrice: 650_000,
      beds: 4,
      baths: 2.5,
      sqft: null,
      type: "SingleFamilyResidence",
      pool: null,
      hasView: null,
    },
  },
  {
    query: "condos in Santa Ana under $500k with a pool and a view",
    expected: {
      city: "Santa Ana",
      maxPrice: 500_000,
      beds: null,
      baths: null,
      sqft: null,
      type: "Condominium",
      pool: "True",
      hasView: "True",
    },
  },
];
