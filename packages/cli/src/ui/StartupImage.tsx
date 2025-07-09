/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import terminalImage from 'terminal-image';
import path from 'path';
import fs from 'fs';

export const displayStartupImage = async () => {
  const imagePath = path.resolve(process.cwd(), 'assets/pixel_test2.png');
  const imageData = fs.readFileSync(imagePath);
  console.log(
    await terminalImage.buffer(imageData, {
      width: '13%',
      height: '33%',
      preserveAspectRatio: false,
    }),
  );
};
