// @ts-check
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Boldonse',
			cssVariable: '--font-brand',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						weight: 400,
						style: 'normal',
						src: ['./src/assets/fonts/Boldonse-Regular.ttf'],
					},
				],
			},
		},
		{
			provider: fontProviders.local(),
			name: 'Galada',
			cssVariable: '--font-heading',
			fallbacks: ['cursive'],
			options: {
				variants: [
					{
						weight: 400,
						style: 'normal',
						src: ['./src/assets/fonts/Galada-Regular.ttf'],
					},
				],
			},
		},
		{
			provider: fontProviders.local(),
			name: 'Varela Round',
			cssVariable: '--font-body',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						weight: 400,
						style: 'normal',
						src: ['./src/assets/fonts/VarelaRound-Regular.ttf'],
					},
				],
			},
		},
	],
});
