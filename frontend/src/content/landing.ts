export const landing = {
  hero: {
    title: 'EstimateNest',
    subtitle:
      'Real-time collaborative planning-poker for agile teams. No registration required.',
    badge: 'Free · No sign-up · Works on any device',
  },
  features: [
    {
      title: 'Zero sign-up',
      description: 'Create a room and share the link. No accounts, no passwords.',
    },
    {
      title: 'Real-time voting',
      description:
        'See votes appear live. Reveal when ready, or auto-reveal when everyone has voted.',
    },
    {
      title: 'Flexible decks',
      description:
        'Fibonacci, T-shirt sizes, powers-of-two, or bring your own custom scale.',
    },
    {
      title: 'Moderator controls',
      description:
        'Reveal votes, start new rounds, and protect your room with an optional password.',
    },
    {
      title: 'Short room links',
      description:
        'Each room gets a 6-letter code — easy to share in Slack, Teams, or chat.',
    },
    {
      title: 'Rooms expire automatically',
      description:
        'Rooms are deleted after 14 days, so no cleanup needed and no data lingers.',
    },
  ],
  faq: [
    {
      question: 'What is planning poker?',
      answer:
        'Planning poker is an agile estimation technique where team members vote on story points in private, then reveal their estimates together to reach a consensus.',
    },
    {
      question: 'Is EstimateNest really free?',
      answer:
        'Yes — EstimateNest is completely free to use. No sign-up, no credit card, no limits on rooms or participants.',
    },
    {
      question: 'Do participants need an account?',
      answer:
        'No. Anyone can join a room with the link or the 6-letter room code. A name is optional.',
    },
    {
      question: 'What happens to my room?',
      answer:
        'Rooms expire automatically after 14 days. Until then, participants can rejoin with the same link at any time.',
    },
  ],
} as const;
