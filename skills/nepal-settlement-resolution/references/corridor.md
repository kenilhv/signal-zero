# The 32 settlements of the Trishuli corridor

Authoritative list. It mirrors `src/data/gazetteer.json` and `src/data/corridor.json`
in the Signal Zero repository. **A settlement id that is not in this table does not
exist.** Never emit one.

Hazard tier is exposure to the Bhote Koshi / Trishuli mainstem flood path:
**3** = on the mainstem, **2** = on a tributary or a valley-floor road near it,
**1** = ridge or side valley, off the flood path.

## Settlement table

| id | name | district | lat | lon | population | hazard tier | aliases held in the gazetteer |
|---|---|---|---|---|---|---|---|
| `np-rasuwa-timure` | Timure | Rasuwa | 28.216 | 85.383 | 1,240 | 3 | Timure Bazar, Rasuwagadhi, Timure Bazaar |
| `np-rasuwa-syabrubesi` | Syabrubesi | Rasuwa | 28.163 | 85.335 | 3,180 | 3 | Syaphrubesi, Shyaphrubesi, Syabru Besi, Syabrubensi |
| `np-rasuwa-haku` | Haku | Rasuwa | 28.062 | 85.288 | 2,110 | 3 | Haku Besi, Hakubesi, Haku Gaun |
| `np-rasuwa-dhunche` | Dhunche | Rasuwa | 28.112 | 85.297 | 5,420 | 2 | Dunche, Dhunche Bazar, Dhunchhe |
| `np-rasuwa-gosaikunda` | Gosaikunda | Rasuwa | 28.084 | 85.392 | 940 | 1 | Gosainkunda, Gosaikund, Gosain Kunda |
| `np-rasuwa-uttargaya` | Uttargaya | Rasuwa | 28.028 | 85.281 | 2,860 | 3 | Uttar Gaya, Uttargaya Gaunpalika, Uttargaya Dham |
| `np-rasuwa-ramche` | Ramche | Rasuwa | 28.013 | 85.243 | 2,470 | 2 | Ramche Bazar, Naukunda, Ramchhe |
| `np-rasuwa-kalikasthan` | Kalikasthan | Rasuwa | 27.988 | 85.186 | 4,130 | 1 | Kalika Sthan, Kalikasthan Bazar, Kalika |
| `np-rasuwa-thulogaun` | Thulogaun | Rasuwa | 28.098 | 85.196 | 1,630 | 1 | Thulo Gaun, Thulogaon, Parbatikunda, Thulo Gaon |
| `np-nuwakot-betrawati` | Betrawati | Nuwakot | 27.966 | 85.183 | 4,820 | 3 | Betrabati, Betrawoti, Betrawati Bazar, Betrabati Bazaar |
| `np-nuwakot-trishuli-bazar` | Trishuli Bazar | Nuwakot | 27.92 | 85.142 | 12,600 | 3 | Trisuli Bazar, Trishuli, Trisuli Bazaar, Trishuli Bajar |
| `np-nuwakot-battar` | Battar | Nuwakot | 27.905 | 85.155 | 6,240 | 3 | Batar, Battar Bazar, Battar Chowk |
| `np-nuwakot-devighat` | Devighat | Nuwakot | 27.902 | 85.161 | 3,410 | 3 | Debighat, Devi Ghat, Devighat Bazar |
| `np-nuwakot-bidur` | Bidur | Nuwakot | 27.87 | 85.15 | 28,400 | 3 | Bidur Nagarpalika, Vidur, Bidur Municipality, Nuwakot Bazar |
| `np-nuwakot-belkotgadhi` | Belkotgadhi | Nuwakot | 27.845 | 85.18 | 21,100 | 2 | Belkot, Belkot Gadhi, Belkotgadi, Belkotgadhi Nagarpalika |
| `np-nuwakot-tadi` | Tadi | Nuwakot | 27.903 | 85.102 | 11,250 | 2 | Taadi, Tadi Gaunpalika, Chaughada, Taadi Khola |
| `np-nuwakot-suryagadhi` | Suryagadhi | Nuwakot | 27.938 | 85.098 | 10,620 | 2 | Suryagadi, Samundratar, Surya Gadhi |
| `np-nuwakot-meghang` | Meghang | Nuwakot | 27.928 | 85.208 | 7,340 | 2 | Meghang Gaunpalika, Meghan, Meghang Chhap |
| `np-nuwakot-kispang` | Kispang | Nuwakot | 27.905 | 85.035 | 9,840 | 1 | Kispang Gaunpalika, Kispan, Kispang Bazar |
| `np-nuwakot-panchakanya` | Panchakanya | Nuwakot | 27.804 | 85.082 | 10,460 | 1 | Panchkanya, Pancha Kanya, Charghare |
| `np-nuwakot-dupcheshwar` | Dupcheshwar | Nuwakot | 27.955 | 85.289 | 8,720 | 1 | Dupcheshwor, Dupche, Ghyangphedi, Dupcheswar |
| `np-nuwakot-shivapuri` | Shivapuri | Nuwakot | 27.847 | 85.271 | 12,830 | 1 | Sivapuri, Shivapuri Gaunpalika, Shibapuri |
| `np-nuwakot-tarkeshwar` | Tarkeshwar | Nuwakot | 27.876 | 85.216 | 11,540 | 1 | Tarkeshwor, Tarkeswar, Tarkeshwar Gaunpalika |
| `np-nuwakot-likhu` | Likhu | Nuwakot | 27.792 | 85.238 | 9,120 | 1 | Likhu Gaunpalika, Lickhu, Likhu Khola |
| `np-dhading-galchhi` | Galchhi | Dhading | 27.796 | 85 | 5,930 | 3 | Galchi, Galchhi Bazar, Galchhi Gaunpalika |
| `np-dhading-gajuri` | Gajuri | Dhading | 27.766 | 84.907 | 7,410 | 3 | Gajuri Bazar, Gajoori, Gajuri Gaunpalika |
| `np-dhading-benighat` | Benighat | Dhading | 27.8 | 84.8 | 6,870 | 3 | Beni Ghat, Benighat Rorang, Benighat Bazar |
| `np-dhading-nilkantha` | Nilkantha | Dhading | 27.868 | 84.898 | 32,200 | 2 | Nilkantha Nagarpalika, Dhading Besi, Dhadingbesi, Neelkantha |
| `np-dhading-thakre` | Thakre | Dhading | 27.759 | 85.031 | 14,260 | 2 | Thakre Gaunpalika, Kalleri, Thakre Khola |
| `np-dhading-dhunibesi` | Dhunibesi | Dhading | 27.716 | 85.133 | 18,640 | 1 | Dhuni Besi, Dhunibesi Nagarpalika, Dhunibensi |
| `np-dhading-netrawati` | Netrawati | Dhading | 27.943 | 84.947 | 6,120 | 1 | Netrawati Dabjong, Netravati, Netrawoti |
| `np-dhading-khaniyabas` | Khaniyabas | Dhading | 27.932 | 84.828 | 5,240 | 1 | Khaniyabash, Khaniyabas Gaunpalika, Khaniabas |

## Corridor adjacency graph

Undirected. Two settlements are adjacent when they share a river reach or a
single road link. This is the same graph the ranking stage uses for its
neighbourhood statistic, so it is the authoritative notion of "nearby" here -
not straight-line distance.

### Rasuwa

- **Timure** (`np-rasuwa-timure`, tier 3) - Syabrubesi
- **Syabrubesi** (`np-rasuwa-syabrubesi`, tier 3) - Dhunche, Haku, Timure
- **Haku** (`np-rasuwa-haku`, tier 3) - Dhunche, Syabrubesi, Uttargaya
- **Dhunche** (`np-rasuwa-dhunche`, tier 2) - Gosaikunda, Haku, Ramche, Syabrubesi, Thulogaun
- **Gosaikunda** (`np-rasuwa-gosaikunda`, tier 1) - Dhunche
- **Uttargaya** (`np-rasuwa-uttargaya`, tier 3) - Betrawati, Haku, Ramche
- **Ramche** (`np-rasuwa-ramche`, tier 2) - Betrawati, Dhunche, Kalikasthan, Uttargaya
- **Kalikasthan** (`np-rasuwa-kalikasthan`, tier 1) - Betrawati, Ramche, Thulogaun
- **Thulogaun** (`np-rasuwa-thulogaun`, tier 1) - Dhunche, Kalikasthan

### Nuwakot

- **Betrawati** (`np-nuwakot-betrawati`, tier 3) - Dupcheshwar, Meghang, Trishuli Bazar, Kalikasthan, Ramche, Uttargaya
- **Trishuli Bazar** (`np-nuwakot-trishuli-bazar`, tier 3) - Battar, Betrawati, Tarkeshwar
- **Battar** (`np-nuwakot-battar`, tier 3) - Devighat, Meghang, Trishuli Bazar
- **Devighat** (`np-nuwakot-devighat`, tier 3) - Battar, Bidur, Tadi
- **Bidur** (`np-nuwakot-bidur`, tier 3) - Galchhi, Belkotgadhi, Devighat, Tadi
- **Belkotgadhi** (`np-nuwakot-belkotgadhi`, tier 2) - Galchhi, Bidur, Likhu, Tarkeshwar
- **Tadi** (`np-nuwakot-tadi`, tier 2) - Bidur, Devighat, Panchakanya, Suryagadhi
- **Suryagadhi** (`np-nuwakot-suryagadhi`, tier 2) - Kispang, Meghang, Tadi
- **Meghang** (`np-nuwakot-meghang`, tier 2) - Battar, Betrawati, Dupcheshwar, Suryagadhi
- **Kispang** (`np-nuwakot-kispang`, tier 1) - Netrawati, Suryagadhi
- **Panchakanya** (`np-nuwakot-panchakanya`, tier 1) - Galchhi, Tadi
- **Dupcheshwar** (`np-nuwakot-dupcheshwar`, tier 1) - Betrawati, Meghang, Shivapuri
- **Shivapuri** (`np-nuwakot-shivapuri`, tier 1) - Dupcheshwar, Likhu, Tarkeshwar
- **Tarkeshwar** (`np-nuwakot-tarkeshwar`, tier 1) - Belkotgadhi, Shivapuri, Trishuli Bazar
- **Likhu** (`np-nuwakot-likhu`, tier 1) - Dhunibesi, Belkotgadhi, Shivapuri

### Dhading

- **Galchhi** (`np-dhading-galchhi`, tier 3) - Gajuri, Nilkantha, Thakre, Belkotgadhi, Bidur, Panchakanya
- **Gajuri** (`np-dhading-gajuri`, tier 3) - Benighat, Galchhi, Nilkantha, Thakre
- **Benighat** (`np-dhading-benighat`, tier 3) - Gajuri, Khaniyabas, Nilkantha
- **Nilkantha** (`np-dhading-nilkantha`, tier 2) - Benighat, Gajuri, Galchhi, Khaniyabas, Netrawati
- **Thakre** (`np-dhading-thakre`, tier 2) - Dhunibesi, Gajuri, Galchhi
- **Dhunibesi** (`np-dhading-dhunibesi`, tier 1) - Thakre, Likhu
- **Netrawati** (`np-dhading-netrawati`, tier 1) - Khaniyabas, Nilkantha, Kispang
- **Khaniyabas** (`np-dhading-khaniyabas`, tier 1) - Benighat, Netrawati, Nilkantha


## Mainstem order, upstream to downstream

The flood path. Everything not in this list is off the mainstem.

```
Tibet (Kyirong / Gyirong)
 -> Rasuwagadhi border point  [ALIAS OF TIMURE, not its own entry]
 -> Timure          Rasuwa    28.216 N   tier 3
 -> Syabrubesi      Rasuwa    28.163 N   tier 3   Langtang Khola joins here
 -> Haku            Rasuwa    28.062 N   tier 3
 -> Uttargaya       Rasuwa    28.028 N   tier 3
 -> Betrawati       Nuwakot   27.966 N   tier 3   RASUWA / NUWAKOT BOUNDARY
 -> Trishuli Bazar  Nuwakot   27.920 N   tier 3
 -> Battar          Nuwakot   27.905 N   tier 3
 -> Devighat        Nuwakot   27.902 N   tier 3
 -> Bidur           Nuwakot   27.870 N   tier 3   Nuwakot district HQ
 -> Galchhi         Dhading   27.796 N   tier 3
 -> Gajuri          Dhading   27.766 N   tier 3
 -> Benighat        Dhading   27.800 N   tier 3   Budhi Gandaki joins; Mugling beyond
```

Dhunche (28.112 N, tier 2) is the **district headquarters of Rasuwa** and appears in
almost every article about the district, but it sits on the road above the river rather
than on the flood path. Its prominence in text is not evidence of exposure, and a
mainstem mention must not drift to it.

## District membership, for the district-only rule

Naming one of these districts and nothing more resolves to **nothing**. The counts are
why:

- **Rasuwa** - 9 settlements: Timure, Syabrubesi, Haku, Dhunche, Gosaikunda, Uttargaya,
  Ramche, Kalikasthan, Thulogaun.
- **Nuwakot** - 15 settlements: Betrawati, Trishuli Bazar, Battar, Devighat, Bidur,
  Belkotgadhi, Tadi, Suryagadhi, Meghang, Kispang, Panchakanya, Dupcheshwar, Shivapuri,
  Tarkeshwar, Likhu.
- **Dhading** - 8 settlements: Galchhi, Gajuri, Benighat, Nilkantha, Thakre, Dhunibesi,
  Netrawati, Khaniyabas.

## Local-level unit names that appear as aliases

These are **gaunpalika / nagarpalika** (rural / urban municipality) names, not separate
settlements. They are already carried as aliases above, listed here so they are not
mistaken for missing entries.

| Unit name in text | Resolves to |
|---|---|
| Naukunda | Ramche |
| Parbatikunda | Thulogaun |
| Uttargaya Gaunpalika | Uttargaya |
| Bidur Nagarpalika / Nuwakot Bazar | Bidur |
| Belkotgadhi Nagarpalika / Belkot | Belkotgadhi |
| Nilkantha Nagarpalika / Dhading Besi / Dhadingbesi | Nilkantha |
| Benighat Rorang | Benighat |
| Chaughada | Tadi |
| Samundratar | Suryagadhi |
| Charghare | Panchakanya |
| Ghyangphedi / Dupche | Dupcheshwar |
| Kalleri | Thakre |
| Netrawati Dabjong | Netrawati |
| Meghang Chhap | Meghang |

## Names that are NOT in the gazetteer

Do not resolve these to anything, however close the character similarity looks.

| Name | What it actually is |
|---|---|
| Rasuwa, Nuwakot, Dhading | districts |
| Bagmati | province (also a different river) |
| Thulo Syabru | a hillside village above the Langtang trail; not carried here |
| Langtang, Kyanjin Gumba | Langtang valley, a different drainage |
| Kyirong / Gyirong / Kerung | the Tibetan side of the border |
| Mugling, Narayanghat, Devghat | far downstream, Chitwan / Tanahun |
| Barhabise, Tatopani, Kodari, Liping, Melamchi, Jure, Listi, Chaku | the **other** Bhote Koshi, in Sindhupalchok |
| Trishuli, Bhote Koshi, Tadi Khola, Likhu Khola, Thakre Khola, Budhi Gandaki, Mahesh Khola | rivers and streams |
| Gosaikunda lake, Parvati Kunda | lakes (Gosaikunda the settlement does exist; the lake mention alone does not resolve) |
