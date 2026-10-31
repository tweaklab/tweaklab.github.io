import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      publishedAt: z.coerce.date(),
      updatedAt: z.coerce.date().optional(),
      heroImage: z.union([z.string().startsWith('/'), image()]),
      heroAlt: z.string().min(1),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(true),
    }),
});

export const collections = { blog };
