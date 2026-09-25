# Search synonyms: Bengali, Banglish and English

The search dictionary. People in Bangladesh search the same thing three ways, often
misspelled and often mixed: ডাক্তার, daktar, doctor, dakter. Transliteration
(`apps/api/src/search/text/transliterate.ts`) and Meilisearch typo tolerance catch most
spelling differences. This file covers what they can't:

- **English words for Bengali ones** (ডাক্তার = doctor, ইলেকট্রিশিয়ান = electrician);
- **different words for the same thing** (বাসা = বাড়ি = house, মেকানিক = mistri);
- **spellings too far apart for typo tolerance** (chittagong = chattogram = ctg).

It is a long-lived asset: anyone can add to it, and every addition makes search better for everyone.

## How it is used

1. `pnpm --filter @amar-elaka/api search:synonyms` parses the dictionary below and writes
   `apps/api/src/search/synonyms/search-synonyms.generated.ts`. A unit test fails if that file
   is out of date, or if the dictionary breaks one of the rules below.
2. The search worker applies the synonyms to every Meilisearch index when it starts, so they
   go live with the next deploy. `pnpm --filter @amar-elaka/api search:reindex` applies them
   immediately.
3. The same groups give each indexed Bengali word its English equivalent (a listing titled
   "ইলেকট্রিশিয়ান করিম" is also indexed under "electrician").

Locality names and aliases (`localities.aliases`, schema §3.1) are added as synonyms
automatically. Don't repeat them here.

## Rules

- **One group per line**, starting with `- `. The terms are separated by commas and are all
  interchangeable: searching any one of them finds the others.
- **One-way lines** use `->`: `- mistri -> electrician, plumber` means searching "mistri" also
  finds electricians and plumbers, but searching "plumber" doesn't find every mistri. The
  terms left of the arrow are interchangeable with each other.
- **Latin terms are lower-case.** Bengali is written normally and is NFC-normalised when
  parsed.
- **Only true equivalents.** A group means "a searcher typing any of these wants all of them".
  A broader term belongs on the left of a one-way line, not in a group.
- **A term may start only one line** (be a group member or a one-way source once). The test
  reports duplicates.
- **Multi-word terms** are fine (`bus stand`), with no commas inside a term.
- **Don't add simple spelling variants** that transliteration already produces (basa and
  basha for বাসা, sobji and shobji for সবজি). Add a spelling when it's far from the
  transliteration (dhanmondi for ধানমন্ডি is close; chittagong for চট্টগ্রাম is not) or
  when people misspell the Bengali itself (ডাক্টার, ইলেক্ট্রিশিয়ান).
- **Short Latin words (3 letters or fewer) that are also English words** (has, mat, sit) cause
  false matches. Leave them out unless there is no real ambiguity.

Headings below are only for people; the parser reads every `- ` line between the markers.

<!-- dictionary:start -->

### Health and medical

- ডাক্তার, ডাক্টার, ডক্টর, daktar, dakter, daktor, doktor, doctor, dr
- হাসপাতাল, হসপিটাল, hospital, haspatal
- ক্লিনিক, clinic, klinik
- ফার্মেসি, ফার্মেসী, ওষুধের দোকান, pharmacy, farmesi, pharmesi, medicine shop, oshudher dokan
- ওষুধ, ঔষধ, osudh, oshudh, oushodh, medicine
- ডেন্টিস্ট, দাঁতের ডাক্তার, dentist, dater daktar
- ডায়াগনস্টিক, ডায়াগনস্টিক সেন্টার, diagnostic, diagnostic center, diagnostic centre
- নার্স, nurse
- অ্যাম্বুলেন্স, এম্বুলেন্স, ambulance, ambulens
- রক্ত, blood, rokto
- শিশু বিশেষজ্ঞ, শিশু ডাক্তার, child specialist, pediatrician, child doctor
- গাইনি, গাইনী, gynae, gyne, gynecologist
- চোখের ডাক্তার, eye specialist, eye doctor, chokher daktar
- ফিজিওথেরাপি, physiotherapy, physio

### Home services and trades

- ইলেকট্রিশিয়ান, ইলেক্ট্রিশিয়ান, ইলেকট্রিসিয়ান, বিদ্যুৎ মিস্ত্রি, electrician, electrishian, current mistri, bidyut mistri
- প্লাম্বার, পানির মিস্ত্রি, plumber, plambar, panir mistri
- কাঠমিস্ত্রি, কাঠ মিস্ত্রি, carpenter, kath mistri
- রাজমিস্ত্রি, রাজ মিস্ত্রি, mason, raj mistri
- রং মিস্ত্রি, রঙ মিস্ত্রি, painter, rong mistri
- মেকানিক, mechanic, mekanik
- এসি মেকানিক, এসি সার্ভিসিং, এসি মেরামত, ac repair, ac mechanic, ac servicing
- মোবাইল সার্ভিসিং, মোবাইল মেরামত, mobile repair, mobile servicing
- মিস্ত্রি, mistri, mistiri -> electrician, plumber, carpenter, mason, painter, mechanic
- গৃহকর্মী, কাজের বুয়া, বুয়া, maid, housemaid, buya, bua
- ক্লিনার, পরিষ্কার পরিচ্ছন্নতা, cleaner, cleaning, cleaning service
- পেস্ট কন্ট্রোল, pest control
- ডিশ লাইন, ডিশ, dish line, cable tv
- ইন্টারনেট, ওয়াইফাই, ব্রডব্যান্ড, internet, wifi, wi fi, broadband
- টিউটর, গৃহশিক্ষক, প্রাইভেট টিউটর, টিউশন, tutor, home tutor, private tutor, tuition, tiushoni
- ড্রাইভার, চালক, driver, draibhar, chalok
- ডেলিভারি, delivery, delibhari
- লন্ড্রি, ধোপা, laundry, dhopa
- দর্জি, টেইলার্স, টেইলর, tailor, tailors, dorji
- বিউটি পার্লার, পার্লার, beauty parlour, parlour, parlor
- সেলুন, নাপিত, salon, saloon, barber, napit
- বাসা বদল, শিফটিং, house shifting, shifting, home shifting, moving

### Rent and property

- বাসা, বাড়ি, basa, bari, house, home
- ভাড়া, bhara, vara, bhada, rent, rental
- টু-লেট, টুলেট, to let, tolet
- ফ্ল্যাট, ফ্লাট, flat, apartment
- সাবলেট, sublet, sablet
- মেস, mess
- রুম, ঘর, room, ghor
- বেডরুম, শোবার ঘর, bedroom
- বাথরুম, টয়লেট, bathroom, toilet, washroom
- দোকান, শপ, dokan, shop
- অফিস, office, ofis
- গ্যারেজ, garage
- গুদাম, গোডাউন, godown, gudam, warehouse
- জমি, প্লট, land, plot, jomi
- লিফট, lift, elevator
- পার্কিং, parking
- ফার্নিচার, আসবাব, আসবাবপত্র, furniture
- জেনারেটর, generator
- পরিবার, ফ্যামিলি, family, poribar
- ব্যাচেলর, ব্যাচেলার, bachelor, bachelar

### Vehicles and transport

- গাড়ি, প্রাইভেট কার, gari, car, private car
- রেন্ট এ কার, গাড়ি ভাড়া, rent a car, gari bhara, car rent, car rental
- মাইক্রোবাস, মাইক্রো, হাইস, microbus, micro, hiace
- সিএনজি, অটোরিকশা, cng, autorickshaw, auto rickshaw
- রিকশা, রিক্সা, rickshaw, riksha
- মোটরসাইকেল, মোটর সাইকেল, বাইক, motorcycle, motor cycle, bike, motorbike
- সাইকেল, বাইসাইকেল, bicycle, cycle
- পিকআপ, pickup, pick up
- ট্রাক, truck
- বাস, bus
- ভ্যান, van

### Buy and sell

- মোবাইল, মোবাইল ফোন, ফোন, mobile, mobile phone, phone, smartphone
- ল্যাপটপ, laptop, leptop
- কম্পিউটার, computer, pc, desktop
- টিভি, টেলিভিশন, tv, television
- ফ্রিজ, রেফ্রিজারেটর, fridge, refrigerator
- এসি, এয়ার কন্ডিশনার, ac, air conditioner
- ওয়াশিং মেশিন, washing machine
- ফ্যান, পাখা, fan, pakha
- সোফা, sofa
- খাট, khat, cot
- আলমারি, almari, almirah, wardrobe
- গরু, goru, cow
- ষাঁড়, sar, bull
- ছাগল, chagol, goat
- মুরগি, মুরগী, murgi, chicken, hen
- হাঁস, duck
- মাছ, mach, fish
- সবজি, সবজী, sobji, vegetable, vegetables
- চাল, rice
- বই, boi, book, books
- জামা, কাপড়, পোশাক, clothes, dress, jama, kapor
- জুতা, জুতো, juta, shoe, shoes
- পুরাতন, পুরনো, সেকেন্ড হ্যান্ড, used, second hand, puraton

### Jobs

- চাকরি, চাকুরি, চাকরী, chakri, chakuri, job, jobs
- বেতন, salary, beton
- নিয়োগ, niyog, recruitment, hiring
- পার্ট টাইম, খণ্ডকালীন, part time
- সিকিউরিটি গার্ড, দারোয়ান, নিরাপত্তা প্রহরী, security guard, guard, daroyan
- বাবুর্চি, রাঁধুনি, cook, baburchi, chef

### Food

- রেস্টুরেন্ট, রেস্তোরাঁ, রেস্তোরা, হোটেল, restaurant, resturent, restora, hotel
- বিরিয়ানি, বিরানি, biryani, biriyani, birani
- কাচ্চি, kacchi, kachchi
- মিষ্টি, mishti, misti, sweets
- বেকারি, bakery
- চা, tea
- ফাস্ট ফুড, fast food
- ক্যাটারিং, catering
- কেক, cake
- খাবার, khabar, food -> restaurant, biryani, fast food, catering

### Places and institutions

- মসজিদ, masjid, mosjid, mosque
- মন্দির, mondir, temple
- গির্জা, চার্চ, church
- স্কুল, বিদ্যালয়, school, iskul
- কলেজ, college, kolej
- বিশ্ববিদ্যালয়, ভার্সিটি, university, varsity
- মাদ্রাসা, madrasa, madrasha
- কোচিং, coaching, koching
- ব্যাংক, bank
- এটিএম, এটিএম বুথ, atm, atm booth
- বিকাশ, bkash, bikash
- থানা, পুলিশ স্টেশন, police station, thana
- পুলিশ, police
- ফায়ার সার্ভিস, দমকল, fire service, fire station
- পোস্ট অফিস, ডাকঘর, post office
- বাজার, মার্কেট, bazar, bajar, market
- শপিং মল, মল, shopping mall, mall
- বাসস্ট্যান্ড, বাস স্ট্যান্ড, বাস স্টপ, bus stand, bus stop
- রেলস্টেশন, রেল স্টেশন, রেলওয়ে স্টেশন, railway station, rail station, train station
- লঞ্চঘাট, লঞ্চ ঘাট, launch ghat
- পার্ক, park
- আবাসিক হোটেল, গেস্ট হাউস, residential hotel, guest house, guesthouse
- কমিউনিটি সেন্টার, কনভেনশন হল, community center, community centre, convention hall
- জিম, ব্যায়ামাগার, gym, fitness

### Cities and well-known areas

- ঢাকা, dhaka
- চট্টগ্রাম, চিটাগাং, chattogram, chittagong, ctg
- সিলেট, sylhet
- রাজশাহী, rajshahi
- খুলনা, khulna
- বরিশাল, barishal, barisal
- রংপুর, rangpur, rongpur
- ময়মনসিংহ, mymensingh, moymonsingho
- কুমিল্লা, cumilla, comilla, kumilla
- নারায়ণগঞ্জ, narayanganj, narayangonj
- গাজীপুর, gazipur, gajipur
- মিরপুর, mirpur
- উত্তরা, uttara
- ধানমন্ডি, dhanmondi
- গুলশান, gulshan
- মোহাম্মদপুর, mohammadpur
- বনানী, banani
- বাড্ডা, badda
- যাত্রাবাড়ী, jatrabari
- সাভার, savar
- কেরানীগঞ্জ, keraniganj

<!-- dictionary:end -->
