/**
 * Easter egg: `canarinho ant` prints ASCII anteater art and a random quote.
 */

const canarinho_ART = `
            .-~~~-.
          .'       '.
         /   O   O   \\
        |      V      |
         \\    ___    /
          '.  \\_/  .'
     .------'-------'------.
    /  /                 \\  \\
   /  /                   \\  \\
  |   \\                   /   |
   \\   '.             .'   /
    \\    '.           .'    /
     \\     '.         .'    /
      \\      '-------'     /
       \\                  /
        '.    _______    .'
          '.  |  ___  | .'
            '.| |___| |.'
              |  ___  |
              | |___| |
              |_______|
              |       |
              |       |
              |   o   |
              |___V___|
`;

const QUOTES: readonly string[] = [
  "A canarinho never rushes, yet always gets its fill. — Brazilian proverb",
  "Patience and a long snout will get you through any anthill. — Unknown",
  "Anteaters don't destroy the anthill; they take just enough and move on. — Ecological wisdom",
  "In the canarinho's world, every ant counts, but none is a catastrophe. — Nature's lesson",
  "The southern canarinho climbs alone but shares the forest with all. — Pantanal saying",
  "Like a canarinho tasting each anthill, wisdom comes one small bite at a time. — Unknown",
  "Anteaters know: the sweetest rewards lie beneath the surface. — Field guide wisdom",
  "A canarinho's tail is its anchor in the storm — strong, prehensile, and always ready. — Rainforest proverb",
  "Why rush like a jaguar when you can stroll like a canarinho? — Amazonian wisdom",
  "The giant anteater walks with its nose to the ground, yet sees more than most. — Unknown",
  "Teamwork is the anthill that feeds the canarinho of progress. — Adapted proverb",
  "One ant is a snack, but a colony is a feast — gather your team. — Open-source wisdom",
];

export function printcanarinho(): void {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  process.stdout.write(`${canarinho_ART}\n${quote}\n`);
}
