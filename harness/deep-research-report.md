# Designing and Making Your Own Harness: Engineering, Safety, Standards and Practical Construction

## Executive summary

A “harness” can mean anything from a costume webbing rig to equipment intended to arrest a human fall. Those products may look superficially similar, but they occupy very different engineering and regulatory categories. A 25 mm strip of webbing rated to 18 kN does **not** make an 18 kN harness: sewn joints, adjusters, buckle routing, attachment-point geometry, hardware orientation, ageing, fit and the way loads are distributed through a body all determine whether the finished assembly survives a load without causing serious injury. The UIAA's current safety-standard catalogue identifies **UIAA 105** for climbing harnesses and UIAA 121 for connectors, while UIAA 105 is based on EN 12277 and adds requirements of its own. citeturn18view0turn20view0

The central recommendation of this report is therefore:

> **Do not DIY a harness that will arrest a human fall, support a climber, restrain a child in a vehicle, restrain a dog in a vehicle crash, or serve as primary riding/driving/traction tack for a horse.** For those applications, buy appropriately certified equipment or, if you intend to develop a new commercial design, treat it as a product-engineering project involving qualified sewing engineers, destructive testing, instrumented test rigs and the applicable conformity-assessment process. OSHA, EN/UIAA and national standards test the *complete system or assembly*, not simply the raw webbing. citeturn15search3turn20view2turn22view5

DIY is much more defensible for a **costume/prop harness that never supports a person** and, with considerably more care, a **dog walking harness that is explicitly not a vehicle restraint, lifting harness or tie-out harness**. The detailed build plans below are limited to those categories. For high-risk categories I give the engineering architecture, required performance envelope and laboratory-development sequence rather than representing a home-sewn prototype as safe PPE.

### Risk comparison

| Harness type | Typical job | Consequence of failure | DIY position |
|---|---|---:|---|
| Industrial fall-arrest | Stops a worker after a fall | **Catastrophic** | **Do not DIY for use**; certified full-body harness only |
| Climbing / mountaineering | Belay, suspension, leader fall | **Catastrophic** | **Do not DIY for use**; EN 12277/UIAA 105 equipment |
| Child vehicle restraint | Controls a child during a collision | **Catastrophic** | **Never DIY** |
| Dog vehicle/crash restraint | Controls dog excursion in a collision | **Very high** | **Never rely on a DIY walking harness** |
| Horse driving / traction / primary riding tack | Controls or transmits forces from a large animal | **High–catastrophic** | Professional harness maker/saddler strongly recommended |
| Child walking harness / reins | Prevents separation while walking | **High consequence** | Prefer a product conforming to EN 13210-1 |
| Dog walking harness | Leash control during ordinary walking | Moderate–high | DIY possible with conservative design and inert-load testing |
| Costume / lightweight utility | Carries props or accessories | Low, **provided it never supports a person** | Good DIY category |

The distinction between an ordinary dog walking harness and a crash restraint is particularly important. Center for Pet Safety testing found stitching, webbing and hardware failures among products making restraint claims; its preliminary strength test uses a rigid dog-form surrogate followed by separate crash testing, and CPS explicitly states that surviving a quasi-static strength test does **not** establish crash protection. citeturn22view0turn22view1

Likewise, children's walking harnesses are covered by BS EN 13210-1:2020, which specifies safety requirements and tests for strap/fabric assemblies for children from birth to 48 months, but explicitly excludes restraints for motorised vehicles. Vehicle child restraints instead fall within specialised regimes such as UN Regulation No. 129 for Enhanced Child Restraint Systems. citeturn23search0turn23search1

## Harness types, standards and the legal landscape

Because no jurisdiction was specified, there is **no single universal legal answer**. In many places, three layers coexist: occupational-safety law, voluntary or consensus technical standards, and separate product/conformity rules applying when equipment is manufactured or placed on the market. A DIY harness may therefore be legally very different when made for private costume use, supplied to another person, sold commercially, or used by an employee at work.

### Major standards and regulations

| Region / use | Principal reference | What it means for a DIY builder |
|---|---|---|
| United States — work at height | OSHA 29 CFR 1910.140; construction also 29 CFR 1926.502 | Binding workplace requirements. Components and complete systems must satisfy specified performance criteria. citeturn15search3turn15search7 |
| United States — industry consensus | ANSI/ASSP Z359 series; Z359.11-2021 specifically addresses full-body harnesses | Z359.11 covers performance, design, marking, qualification, training, testing, inspection, maintenance and retirement; its stated harness user-capacity range is 59–140 kg. citeturn22view5 |
| EU/EEA — fall PPE | Regulation (EU) 2016/425; EN 361 full-body harnesses; EN 362 connectors | Fall-from-height PPE is in the EU's highest-risk PPE framework; manufacturers placing such PPE on the market have conformity-assessment, documentation and marking obligations. citeturn16search5turn16search8turn0search10 |
| UK — workplace | Work at Height Regulations 2005 | Personal fall-protection systems must be selected following risk assessment and must be suitable for the user, task and conditions; local product-conformity requirements should also be checked separately. citeturn10search4turn10search8 |
| India — occupational fall arrest | IS 3521 (Part 1):2021 full-body harness; Part 5:2021 connectors | BIS lists the current full-body-harness specification, reviewed in 2026; the connector part covers self-closing/self-locking connectors. Check the exact employer/sector requirements applicable to your worksite. citeturn13search0turn12search24 |
| Canada — federally regulated workplaces | Canada Occupational Health and Safety Regulations plus applicable CSA/local standards | Federal guidance requires fall-protection planning in specified circumstances, prioritises prevention/restraint ahead of arrest, and requires appropriate training and manufacturer instructions. Provincial rules can differ. citeturn9search1 |
| Australia / New Zealand | AS/NZS 1891 series; AS/NZS 1891.4:2025 for selection, use and maintenance | Standards Australia identifies the 2025 edition as the current selection/use/maintenance reference. A standard is not automatically legislation merely because it exists; WHS legislation and codes determine its legal role. citeturn11search7turn11search2 |
| Recreational climbing | EN 12277; UIAA 105 | Applies to climbing/mountaineering harness design and strength. UIAA 105 adds requirements to EN 12277. citeturn20view0turn20view2 |
| Climbing connectors | EN 12275; UIAA 121 | Use connectors actually certified for the intended climbing application, not generic snap hooks. Petzl's certified OK is one example. citeturn18view0turn21view1 |
| Child walking harness/reins | EN 13210-1:2020 / BS EN 13210-1:2020 | Dedicated child-product safety requirements; not a vehicle-restraint standard. citeturn23search0 |
| Child vehicle restraint | UN Regulation No. 129 where adopted | Treat as a complete crash-restraint system; **no DIY substitution**. UNECE was still processing amendments to R129 in 2026. citeturn23search1turn23search21 |
| Dog vehicle restraint | CPS-001-014.01 certification/testing programme | Voluntary rather than government law, but useful independent evidence that crash strength and occupant excursion require specialised testing. citeturn22view0turn22view1 |
| Horse tack / driving harness | Local animal-welfare/road rules; professional tack-fitting practice | There is no sensible universal “one strength rating” for all horse harnesses. UK guidance, for example, requires suitable, correctly fitted, regularly checked driving harness/tack. citeturn22view2turn22view3 |

**US industrial example.** OSHA requires D-rings, snaphooks and carabiners in relevant personal fall-protection systems to have a minimum tensile strength of **5,000 lbf / 22.2 kN**, and its connector-gate provisions include a **3,600 lbf / approximately 16 kN** minimum gate-strength requirement. OSHA also limits free fall in a conventional personal fall-arrest system to 6 ft / 1.8 m and sets complete-system performance requirements. Those numbers illustrate why replacing a certified D-ring with a visually similar craft or pet-supply ring is not an acceptable engineering substitution. citeturn5search0turn5search2turn5search10

**EU example.** Regulation (EU) 2016/425 contains specific essential requirements for PPE intended to prevent falls from height, while Category III covers hazards capable of causing death or irreversible health damage. Commercial manufacture therefore entails substantially more than selecting “strong webbing”: technical documentation, conformity assessment, production controls and user information are part of the product regime. citeturn16search5turn16search8

**Climbing example.** The UIAA's simplified EN 12277/UIAA 105 test illustration shows main load-bearing tape widths of at least 43 mm for the principal body-contact sections of standard harnesses, with narrower provisions for small-body/chest-harness configurations; it also depicts static tests including **15 kN for sit harnesses**, **10 kN for chest harnesses**, and different full-body/small-body loading configurations, with maximum buckle slippage of 20 mm. It additionally requires conspicuous contrasting visible load-bearing stitching. These are *assembly qualification tests*, not instructions to make a safe harness from 43 mm tape. citeturn20view2

A useful primary visual reference is the UIAA's official one-page EN 12277/UIAA 105 pictorial test sheet, which illustrates the test dummy, strap-width requirements, loading directions, test forces and buckle-slip requirement. citeturn20view2

## Materials, webbing, stitching, hardware and tools

The sound design rule is to distinguish **raw-component strength** from **finished-assembly strength**.

A commercially specified 18 kN piece of webbing can be weakened at a sewn fold, crushed or cut by incompatible hardware, loaded across a sharp edge, damaged during sewing, incorrectly threaded through an adjuster, or incorporated into a harness whose body geometry allows the wearer to fall out. Consequently, component numbers should be treated as inputs to qualification testing rather than as the finished harness's rating. UIAA and ANSI test the harness assembly precisely because component ratings alone are insufficient. citeturn20view2turn22view5

### Materials-strength reference

| Material / component | Published rating or specification | Appropriate interpretation |
|---|---:|---|
| BlueWater 25.4 mm Climb-Spec tubular nylon webbing | **18 kN / 4,046 lbf tensile** | Excellent example of traceable high-strength webbing. Its 18 kN rating does **not** certify a harness sewn from it. citeturn21view2 |
| PMI 25 mm Work-Spec tubular webbing | **18 kN / about 4,000 lbf** | Another purpose-made technical webbing option; use manufacturer traceability rather than unmarked craft webbing. citeturn8search14 |
| MIL-W-4088 family webbing | Multiple types/materials | “Mil-spec” is a family designation, not one universal strength. Bally Ribbon Mills and Murdock manufacture webbing to MIL-W-4088 families; specify the exact type and obtain its certificate/data sheet. citeturn8search11turn8search7 |
| 45 mm polyester load webbing | Used in certified climbing harnesses; standalone rating product-dependent | Edelrid's JOKER, for example, uses 45 mm polyester webbing while the *finished harness* carries EN 12277 Type C/UIAA 105 certification. Material name alone does not establish strength. citeturn1search22 |
| AustriAlpin D-Ring COBRA ProStyle | Buckle **18 kN straight / 36 kN loop**; D-ring **22 kN straight MBS** | High-quality rated hardware; nevertheless it does not certify whatever webbing/seam you attach to it. Current manufacturer price shown as US$22–46 depending on configuration. citeturn21view0 |
| Petzl OK locking carabiner | **25 kN major / 8 kN minor / 7 kN open gate** | Good illustration of directional strength: even certified hardware loses much of its rated capacity when loaded incorrectly. Certified to EN 12275, EN 362 and UIAA requirements. citeturn21view1 |
| Coats Nylbond Sling bonded nylon thread | High-tenacity nylon 6.6; specifically intended for lifting-sling sewing | Suitable *class* of industrial thread, but thread strength alone does not predict seam strength. Final seam must be destructively tested. citeturn16search7 |
| Foam / spacer mesh / neoprene | No structural rating assumed | Comfort layer only. The webbing should carry the load continuously underneath it. |

**MBS means minimum breaking strength, not safe working load.** Do not convert 18 or 25 kN into “how many kilograms this harness can hold” and then use that as a person rating. Fall loads are dynamic, the load direction changes, and the human body itself imposes limits. Petzl, for example, publishes three different strength values for the same carabiner depending on orientation and gate state. citeturn21view1

### Recommended material hierarchy

For **certification-development prototypes**, buy technical webbing directly from recognised manufacturers such as BlueWater, PMI, Bally Ribbon Mills or Murdock, retaining lot/batch information and specification sheets. BlueWater's 25 mm Climb-Spec nylon is currently specified at 18 kN and US$165.63 for a 100-yard manufacturer spool. citeturn21view2turn8search11turn8search7

For **dog walking**, 25–38 mm high-quality nylon or polyester webbing gives a practical base. Wider padded contact zones are preferable for large or powerful dogs. For a dog that lunges hard, is an escape risk, or is walked near traffic, buying a professionally tested harness is more defensible than depending on home sewing. A walking harness described here must never be represented as a crash-tested restraint. CPS testing demonstrates that seemingly robust harnesses can fail through stitching and hardware during crash loading. citeturn22view0

For **costume/utility use**, ordinary good-quality polyester or nylon webbing is adequate because body suspension is explicitly excluded. Acetal side-release buckles may be useful for these low-risk applications, but they should not be silently substituted for rated metal fall-arrest hardware.

### Stitching

Industrial harness construction often uses programmable bar-tacks or other repeatable multi-pass seams. The significant point is that **“bar-tack”, “box-X” and stitch count are geometries, not safety ratings**. Thread material and size, webbing weave, needle diameter, stitch density, overlap length, thread tension, abrasion and exactly where the needle perforates the webbing all affect the final joint. The UIAA therefore tests the completed harness and separately requires visible load-bearing stitching to contrast with its tape; Petzl inspection guidance likewise treats damaged safety stitching as a reason for concern. citeturn20view2turn15search14

For low-risk homemade products, the following is a useful **prototype seam**, but it has no EN/UIAA/ANSI rating:

```text
Example fixed overlap — DOG WALKING / COSTUME ONLY
Not for climbing, fall arrest, child restraint or suspension

   webbing overlap, typically ≈ 100–125 mm
   ┌─────────────────────────────┐
   │  ┌───────────────────────┐  │
   │  │\                     /│  │
   │  │  \                 /  │  │
   │  │    \             /    │  │
   │  │      \         /      │  │
   │  │        \     /        │  │
   │  │          \ /          │  │
   │  │          / \          │  │
   │  │        /     \        │  │
   │  │      /         \      │  │
   │  │    /             \    │  │
   │  │  /                 \  │  │
   │  │/                     \│  │
   │  └───────────────────────┘  │
   └─────────────────────────────┘
       rectangular perimeter + X
```

On a low-risk product, I would use **two spatially separated stitch blocks** rather than depending on one small dense stitch cluster. Sew test coupons first and pull them destructively. For life-safety development, do not copy this drawing: have the seam programme designed and validated experimentally.

Use a contrasting thread colour because it makes inspection dramatically easier; this is also consistent with the inspection philosophy used by UIAA and Petzl for safety stitching. citeturn20view2turn15search14

Coats' Nylbond Sling is a particularly relevant primary-source example of high-tenacity nylon 6.6 thread specifically designed for sling manufacturing; ordinary lightweight domestic garment thread should not be used where a structural seam is expected to carry meaningful load. citeturn16search7

### Workshop tools

For the low-risk plans in this report, the practical tool set is an appropriately capable sewing machine, suitable heavy needles, bonded nylon/polyester thread, steel ruler, measuring tape, tailor's chalk, sharp webbing shears or hot knife, clamps rather than pins in structural regions, seam ripper, lighter/hot cutter for *ends only*, and a simple load-test fixture.

For engineering development of a life-safety harness, this expands to an industrial walking-foot or programmable pattern-tacking machine, calibrated tensile-test machine/load cell, proper grips that do not cut the webbing, dimensional gauges, batch traceability records, test torso/dummy and eventually an instrumented dynamic test facility. ANSI Z359.11 expressly deals with qualification and test methods, while EN/UIAA use specified harness dummies and loading configurations. citeturn22view5turn20view2

Avoid rivets, eyelets or grommets through a primary webbing load path unless the complete configuration has been engineered and tested. Also avoid solvent markers, adhesives or heat treatment on structural webbing unless the textile manufacturer expressly approves them; Petzl inspection guidance flags heat and chemical damage as retirement concerns, and Teufelberger's work on webbing marking cautions that compatibility is material-specific. citeturn15search14turn7search2

## Construction plans and patterns

The plans below deliberately separate **DIY-suitable construction** from **professional-development-only construction**.

### Walking-only Y-front dog harness

This plan is for ordinary leash walking. It is **not** for use in a car, on a motorcycle, for lifting, climbing, rappelling, skijoring, pulling a cart, tying a dog unattended, or any situation in which failure could produce a major fall.

Take four measurements with the dog standing naturally:

- **N** — circumference around the base of the neck/shoulders, not high across the throat.
- **G** — chest girth just behind the forelegs.
- **B** — distance along the back from the neck-line junction to the girth line.
- **S** — distance along the sternum from the front breastbone to the girth line between the forelegs.

An approximate procurement length is:

\[
L \approx N + G + B + S + 0.6\text{ m}
\]

then add about **10–15% for fitting waste and adjustment tails**. This is a cutting allowance, not a load-related formula.

```text
Y-FRONT DOG WALKING HARNESS

                   dorsal view
                       [ D ]
                        │
                 dorsal bridge B
                        │
             ┌──────────┴──────────┐
             │                     │
          neck side             neck side
             \                     /
              \                   /
               \                 /
                \               /
                 \             /
                  [ breastbone ]
                       │
                 sternum S
                       │
           ┌───────────┴───────────┐
           │                       │
           └──── girth loop G ─────┘
                 behind forelegs

[D] = leash D-ring
All black load paths are continuous webbing.
Padding is added around them, never substituted for them.
```

**Construction sequence.** First make a disposable fitting mock-up from cheap tape or ribbon. Establish the Y junction on the sternum so that tension is directed onto the chest rather than directly across the throat. Establish the girth strap far enough behind the elbows that normal gait does not chafe it. Once the geometry is confirmed, transfer those dimensions to the structural webbing.

Cut the structural pieces, leaving generous adjustment tails. Hot-cut only the ends in good ventilation; do not melt or stiffen regions that will bend around buckles. Build the adjustable neck and girth sections with correctly sized triglides/ladder locks and a robust side-release or metal buckle. Make sure the webbing lies flat through every adjuster.

Create the dorsal leash point by folding the dorsal webbing through a **closed/welded metal D-ring** and returning a long overlap onto itself. Use two independent, separated stitch blocks in the overlap. Do not depend upon a tiny folded tab stitched into padding.

Connect the dorsal bridge, two neck legs, sternum member and girth loop. Wherever practical, make the load path continuous rather than terminating several structural pieces at one small decorative patch.

Add padding only after the webbing geometry is correct. The padding should be replaceable without cutting structural stitching.

Fit the finished harness. You should be able to put fingers under the straps without large loose loops, and the dog should be able to walk, sit and lie down without the straps migrating onto the throat or into the armpits.

Finally sew an obvious permanent label:

> **WALKING ONLY — NOT VEHICLE RESTRAINT — NOT FOR LIFTING**

That distinction is important because independent CPS crash work shows that static strength alone cannot establish vehicle-crash performance. citeturn22view1turn22view0

### Costume and lightweight utility H-harness

For cosplay, photography, carrying a radio, lightweight tools or props, the safest DIY principle is to make the harness **incapable of being mistaken for PPE**.

```text
FRONT                         BACK

   shoulder    shoulder         \       /
      │            │             \     /
      │ chest strap│              \   /
   ───┼────────────┼───            \ /
      │            │               X
      │            │              / \
      │            │             /   \
   === waist / utility belt ====/===== \===

NO structural dorsal D-ring
NO belay loop
NO "fall arrest" attachment
Label: NOT PPE / NO SUSPENSION
```

Measure the chest circumference **C**, waist circumference **W**, and shoulder-to-waist routes. Use 25 mm or wider webbing and adjustable buckles. Cut C and W straps with roughly 25–30 cm adjustment allowance, then cut two shoulder members generously and trim only after the whole assembly has been fitted.

Assemble the waist and chest straps first; add shoulder straps only to keep the two bands in position. Sew accessory loops onto a **secondary layer** so that a torn pouch or prop loop does not cut the main strap. Keep any heavy prop as close to the torso as practical.

For a homemade utility rig I recommend imposing an explicit design limit of **5 kg or less of carried equipment**, independent of how strong the webbing appears to be. That is a deliberately conservative project limit, **not a certification or standard**. Never sit, hang, belay or arrest a fall from it.

Label both the front and rear:

> **NOT PPE — NO CLIMBING — NO FALL ARREST — NO BODY SUSPENSION**

### What a professional fall-arrest design looks like conceptually

For understanding rather than DIY use, the load-path architecture of a full-body fall-arrest harness is roughly:

```text
                  dorsal fall-arrest point
                         [ D ]
                          │
                 ╲        │        ╱
                  ╲ shoulder     ╱
                   ╲   straps   ╱
                    ╲         ╱
                ───── chest ─────
                     ╲     ╱
                      ╲   ╱
                       ╳
                      / \
                     /   \
             left thigh  right thigh
                 loop       loop

   Fall load must be distributed through shoulders,
   chest/pelvis and thighs without wearer ejection.

   THIS IS A TOPOLOGY DIAGRAM, NOT A CUTTING PATTERN.
```

OSHA defines a body harness in terms of distributing fall-arrest forces over the thighs, pelvis, waist, chest and shoulders, while ANSI Z359.11 covers complete design and qualification. The EU system similarly treats fall-from-height PPE as a specialised high-risk product. citeturn0search0turn22view5turn16search5

A person actually developing such a product should follow this sequence:

**Define the target standard before designing.** Decide whether the product is an EN 361 occupational full-body harness, ANSI/ASSP Z359.11 harness, IS 3521 harness, EN 12277/UIAA climbing harness, or something else. “Universal harness” is not a sensible starting specification because the required attachment points, body positions and test cases differ. citeturn22view5turn20view0turn13search0

**Build a requirements matrix.** Include body-size range, attachment-point locations, permitted buckle slip, strap widths, static loads, dynamic tests, material ageing, markings, user instructions, inspection, connector compatibility and production QA. UIAA's pictorial, for example, shows width, static-strength and buckle-slip requirements simultaneously. citeturn20view2

**Design and destructively test individual joints first.** Produce many identical webbing/seam coupons and pull them to failure. Record whether failure is thread rupture, webbing tear beside the needle line, hardware deformation, webbing slip, or gradual stitch progression.

**Build sacrificial full assemblies.** Use material lot numbers, controlled sewing-machine settings and manufacturing travellers so that a passing prototype is reproducible.

**Perform dummy-based static qualification**, followed by **instrumented dynamic qualification at an accredited or properly equipped test laboratory**.

**Only after qualification** should ergonomics/suspension trials with humans take place, and those trials should not involve intentional falls.

A prototype that has merely survived a workshop hanging test is **not a climbing or fall-arrest harness**.

### Climbing, horse and child categories

For climbing, buy EN 12277/UIAA 105-certified equipment. The standard's tests include forces in the 10–15 kN range depending on harness class/configuration, controlled dummy geometry and buckle-slip requirements. That is beyond what a domestic sewing project can substantiate. citeturn20view2

For a horse, distinguish decorative equipment from **primary tack**. Riding, driving and draft harnesses put loads onto a powerful moving animal while simultaneously controlling it and/or transmitting vehicle loads. The British Horse Society stresses correct tack fit and regular professional assessment; UK horse-drawn-vehicle guidance likewise calls for appropriate selection, fitting and regular soundness/safety checks. Have load-bearing harness made or assessed by a competent saddler/harness maker. citeturn22view2turn22view3

For child walking reins, use an EN 13210-1-conforming product rather than experimenting on the child; BSI says the standard specifically addresses minimum safety requirements and test methods for children's harness/rein assemblies. For any motor vehicle, a walking harness is not a substitute for an approved child restraint. citeturn23search0turn23search1

## Testing, inspection and maintenance

Testing needs to answer two fundamentally different questions:

1. **Did my low-risk handmade item contain obvious construction defects?**
2. **Does a life-safety product conform to a safety standard?**

The first can be screened in a workshop. The second requires the actual standard and appropriate laboratory equipment.

### Workshop proof test for the dog walking harness

Never test with the dog inside it.

Make a padded rigid surrogate approximately matching the dog's chest geometry. Install the harness exactly as it will be worn. Attach the leash to its normal D-ring and progressively apply an inert load.

For a **non-standard workshop screening test**, I would use an inert test load equal to about **three times the dog's body mass equivalent**, introduced gradually rather than dropped. Example: for a 20 kg dog, a 60 kg suspended test mass produces roughly 0.59 kN of static force. This is deliberately a screening margin, **not evidence of crash protection or a recognised certification criterion**.

Hold the peak load briefly, release it, and repeat several times. Examine every stitch, adjuster and ring after each cycle. Reject the harness for broken threads, webbing cuts, permanent ring deformation, buckle opening or measurable webbing migration.

CPS provides a useful comparison of principle: its preliminary dog-restraint tests use a rigid dog-shaped form and a specified load with a five-second hold before products can advance to crash testing; CPS explicitly cautions that passing this stage is not evidence of crash protection. citeturn22view1

Do **not** perform a home crash/drop test. Dynamic loads can injure the tester, damage anchors and create peak forces poorly represented by the dropped mass itself.

### Workshop proof test for a costume/utility harness

Again, use a mannequin/fixture, not a person.

If you impose the 5 kg accessory limit suggested above, load the attachment system to approximately **15 kg of dead weight** for a workshop screening test. Hold it for several minutes, operate/bump the fixture gently, unload, and inspect. Any structural damage or buckle movement means redesign.

Do not graduate from “it survived 15 kg” to “I can hang my 70 kg body from it”. Those are entirely different applications.

### Static qualification of climbing or fall-PPE prototypes

For a serious engineering project, the test fixture should reproduce the relevant standard, including:

- the prescribed torso/dummy;
- exact loading points and directions;
- calibrated load measurement;
- specified loading rate/time;
- buckle and adjuster configuration;
- dimensional/slippage measurement;
- post-load inspection and documented failure mode.

UIAA's official simplified diagram shows, among other examples, **15 kN sit-harness testing**, **10 kN chest-harness testing**, multiple full-body/small-body orientations and a **20 mm maximum buckle-slip criterion**; it cautions that the pictorial is only a simplified representation and that the full EN/UIAA documents govern. citeturn20view2

That last point matters: do not reverse-engineer a certification programme from the diagram alone.

### Dynamic qualification

A proper dynamic test uses a controlled drop system, standardised mass or anthropomorphic surrogate, qualified anchor, remotely operated release, calibrated force transducer/data acquisition and exclusion zone. It measures **peak arrest force and system behaviour**, not simply whether the webbing broke.

OSHA's fall-protection provisions include system-level force criteria and specified test methodology; its Appendix D testing treats excessive measured maximum arresting force as system failure. citeturn5search3

For a new life-safety product, commissioning an appropriately accredited laboratory is much more rational than constructing an improvised home drop tower. A home fall test that “worked once” tells you little about manufacturing variation, cold/wet performance, ageing or repeated production lots.

### Inspection and retirement

| Interval | What to inspect | Action |
|---|---|---|
| **Before every use** | Entire webbing path, cuts, abrasion, melted/glazed fibres, chemical contamination, stitching, buckle threading, cracks/corrosion/deformation, ring/connector orientation | Remove from service if questionable |
| **After any unusual shock or major load** | Full inspection, especially load points and hidden webbing under buckles | Life-safety PPE should be handled according to manufacturer retirement rules; do not assume invisible damage is harmless |
| **Periodic detailed inspection** | All above plus serial/lot information, wear history and function of every adjustment point | Competent-person inspection; Petzl recommends a detailed PPE inspection at least every 12 months in addition to routine checks |
| **After washing / storage** | Dryness, chemical exposure, mildew, corrosion and stiffness | Air-dry away from damaging heat/chemicals; do not return wet contaminated PPE to long storage |
| **When history is unknown** | History itself is a safety attribute | Retire life-safety harnesses rather than guessing |

OSHA specifically requires personal fall-protection systems to be inspected before initial use during **each workshift** for mildew, wear, damage and deterioration, with defective components removed from service. citeturn15search3turn15search5

Petzl's harness inspection procedure directs users to look for cuts, swelling, heat/chemical damage, worn or cut safety stitching, wear at tie-in points and deformed/cracked/corroded buckles; Petzl recommends a competent-person detailed PPE inspection every 12 months and after an exceptional event. citeturn15search2turn15search14

Petzl has also documented a real canyon-harness failure following severe attachment-point abrasion and continued use beyond the recommended retirement condition, underscoring why a still-intact-looking strap should not be used indefinitely. citeturn15search10

For your own low-risk products, keep a small inspection card:

```text
HARNESS ID: __________
Purpose: WALKING ONLY / COSTUME ONLY
Date made: ___________
Webbing lot/source: ______________
Thread: _________________________
Hardware: _______________________

Date    webbing    stitches    hardware    slip    result
____    _______    ________    ________    ____    PASS / RETIRE
____    _______    ________    ________    ____    PASS / RETIRE
```

That simple discipline becomes invaluable if you make several versions and start changing stitch length, thread, buckle type or webbing.

## Parts, suppliers, costs and risk controls

The following bills of materials are for the two DIY-appropriate projects. Prices are approximate 2026 budget figures in **USD**, excluding shipping, duty and local taxes; the purpose is project budgeting, not a live retail quote. Where a manufacturer currently publishes a price, that is cited directly.

### Walking-only dog harness bill of materials

| Part | Quantity | Specification | Indicative budget |
|---|---:|---|---:|
| Structural webbing | roughly 3–5 m depending on dog | 25–38 mm nylon/polyester; traceable technical webbing preferred | US$8–20 |
| D-ring | 1 | Closed/welded metal, smooth edges | US$3–10 |
| Adjustable triglides | 3–5 | Exact width of webbing | US$5–15 |
| Main buckle | 1 | Robust metal or quality polymer appropriate to load | US$5–20 |
| Bonded thread | 1 spool/cone | Bonded high-tenacity nylon/polyester | US$10–25 |
| Padding / spacer mesh | approx. 0.25–0.5 m² | Comfort only; non-structural | US$5–15 |
| Miscellaneous binding / labels | — | Include permanent use limitation | US$3–8 |
| **Typical project total** | | excluding sewing machine | **about US$35–90** |

As a strength benchmark rather than a requirement, BlueWater's 25 mm Climb-Spec tubular nylon is rated to 18 kN and sells direct in 100-yard spools for US$165.63, equivalent to roughly US$1.81 per metre before retail cut-length premiums. citeturn21view2

### Costume / lightweight utility harness bill of materials

| Part | Quantity | Specification | Indicative budget |
|---|---:|---|---:|
| 25 mm webbing | 5–7 m | Polyester or nylon | US$10–20 |
| Side-release buckles | 2–3 | Non-PPE | US$5–15 |
| Triglides | 4–6 | Matching width | US$5–12 |
| Thread | 1 spool | Bonded polyester/nylon preferred | US$8–20 |
| Padding / edge binding | — | Optional | US$5–15 |
| Labels | — | “NOT PPE / NO SUSPENSION” | US$2–5 |
| **Typical total** | | | **about US$30–75** |

A rated AustriAlpin D-Ring COBRA assembly currently costs approximately US$22–46 direct from the manufacturer depending on size/configuration. That makes sense in professional products where its known mechanical performance is needed, but it is unnecessary expense on a costume harness and, critically, installing a 22 kN D-ring does **not transform the surrounding homemade harness into 22 kN PPE**. citeturn21view0

### Supplier shortlist

**BlueWater Ropes** is a strong source for traceable climbing/industrial nylon webbing; its 25 mm Climb-Spec product publishes construction, mass and an 18 kN tensile rating. citeturn21view2

**PMI** publishes technical Work-Spec webbing around the same 18 kN class. citeturn8search14

**Bally Ribbon Mills** and **Murdock Webbing** are better sources than marketplace listings when you need MIL-W-4088-family products and traceability. Specify the exact material/type rather than ordering merely “mil-spec webbing”. citeturn8search11turn8search7

**AustriAlpin** publishes unusually useful direct specifications for COBRA buckles and D-ring assemblies, including the difference between straight-pull and loop-configuration strengths. It also labels some superficially similar products as unsuitable for PPE, a good illustration of why one should follow the *exact SKU's* documentation. citeturn21view0turn6search27

**Petzl** is useful for certified connectors and inspection references. The current OK locking connector, for example, is specified at 25/8/7 kN major/minor/open and certified under EN 12275, EN 362 and UIAA requirements. citeturn21view1

**Coats** is a primary thread manufacturer; Nylbond Sling is specifically made from high-tenacity nylon 6.6 for lifting-sling sewing. For an engineered harness, request the product information sheet, select thread size in conjunction with your sewing/webbing engineer, and validate the actual seam destructively. citeturn16search7

### Final design rules

The most effective risk controls are architectural rather than cosmetic.

**Never let an untested seam be the only barrier between a person and a fatal fall.** Industrial and climbing systems require qualified complete assemblies. citeturn22view5turn20view2

**Keep the structural webbing continuous.** Padding, mesh and decorative covers should provide comfort, not secretly become load paths.

**Design so hardware loads in the direction for which it is rated.** The same Petzl connector rated 25 kN on its major axis is only rated 8 kN across its minor axis and 7 kN with its gate open. citeturn21view1

**Use only closed, smooth hardware in structural loops.** Inspect for sharp edges, corrosion and deformation; Petzl includes these conditions in formal PPE inspections. citeturn15search14

**Do not confuse stronger raw material with a safer harness.** CPS found examples of pet-restraint failures involving stitching, hardware and webbing despite the individual materials appearing substantial. citeturn22view0

**Separate restraint categories completely.** A dog walking harness is not a crash harness; child walking reins are not a car seat; a positioning belt is not a fall-arrest harness; decorative horse equipment is not driving tack. Each category has different hazards and test requirements. citeturn22view1turn23search0turn20view2

**Never test experimental life-safety equipment by putting a person or animal in it and “seeing whether it holds”.** Qualification should proceed from material coupons to sacrificial assemblies to instrumented surrogate tests.

**For climbing or industrial work, purchasing certified equipment is overwhelmingly preferable to DIY.** Standards such as ANSI/ASSP Z359.11, EN 361, EN 12277/UIAA 105 and India's IS 3521 exist precisely because a correct-looking harness can fail through issues invisible to casual inspection. citeturn22view5turn20view0turn13search0

**For children, vehicle restraints and primary horse tack, the ethical threshold should be even higher:** the wearer or animal cannot meaningfully assess the engineering risk you have created for them. Use appropriately tested commercial equipment and competent professional fitting rather than treating the application as a sewing experiment. BSI's child-harness standard, UNECE's ongoing R129 vehicle-restraint framework and professional equestrian guidance all reflect the need to consider the complete restraint and its user, not merely whether a strap is difficult to break. citeturn23search0turn23search1turn22view2

The practical dividing line is consequently simple: **make the dog walking or costume harness yourself if the consequence envelope is genuinely low and you test it conservatively; engineer life-safety harnesses only as formally qualified products; buy certified equipment when a fall, collision, child or large animal turns a stitching mistake into a potentially irreversible event.**