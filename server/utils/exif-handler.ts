// server/utils/exif-handler.ts
// Enhanced EXIF data writing using piexifjs for better metadata support

import sharp from 'sharp';
import piexif from 'piexifjs';
import { Buffer } from 'buffer';

interface ExifData {
  copyright?: string;
  author?: string;
  software?: string;
  description?: string;
  keywords?: string[];
  dateTime?: Date;
  gpsData?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };
}

export class ExifHandler {
  /**
   * Write EXIF data to an image buffer
   */
  static async writeExifData(
    imageBuffer: Buffer,
    exifData: ExifData
  ): Promise<Buffer> {
    try {
      // First, get the image as JPEG (EXIF works best with JPEG)
      const jpegBuffer = await sharp(imageBuffer)
        .jpeg()
        .toBuffer();
      
      // Convert buffer to base64 for piexifjs
      const jpegData = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
      
      // Get existing EXIF data or create new
      let exifObj: any;
      try {
        exifObj = piexif.load(jpegData);
      } catch {
        // No existing EXIF, create new
        exifObj = {
          '0th': {},
          'Exif': {},
          'GPS': {},
          '1st': {},
          'thumbnail': null
        };
      }
      
      // Add/Update IFD0 (main image) data
      if (exifData.copyright) {
        exifObj['0th'][piexif.ImageIFD.Copyright] = exifData.copyright;
      }
      
      if (exifData.author) {
        exifObj['0th'][piexif.ImageIFD.Artist] = exifData.author;
      }
      
      if (exifData.software) {
        exifObj['0th'][piexif.ImageIFD.Software] = exifData.software || 'AI Content Manager';
      }
      
      if (exifData.description) {
        exifObj['0th'][piexif.ImageIFD.ImageDescription] = exifData.description;
      }
      
      // Add DateTime
      if (exifData.dateTime) {
        const dateStr = exifData.dateTime.toISOString().replace(/T/, ' ').replace(/\..+/, '');
        exifObj['0th'][piexif.ImageIFD.DateTime] = dateStr;
        exifObj['Exif'][piexif.ExifIFD.DateTimeOriginal] = dateStr;
        exifObj['Exif'][piexif.ExifIFD.DateTimeDigitized] = dateStr;
      }
      
      // Add Keywords (as XPKeywords for Windows compatibility)
      if (exifData.keywords && exifData.keywords.length > 0) {
        const keywordsStr = exifData.keywords.join('; ');
        exifObj['0th'][piexif.ImageIFD.XPKeywords] = [...Buffer.from(keywordsStr, 'utf16le')];
      }
      
      // Add GPS data if provided (or remove if not)
      if (exifData.gpsData && !exifData.gpsData.latitude && !exifData.gpsData.longitude) {
        // Remove GPS data
        delete exifObj['GPS'];
      } else if (exifData.gpsData?.latitude && exifData.gpsData?.longitude) {
        // Add GPS data
        const lat = exifData.gpsData.latitude;
        const lon = exifData.gpsData.longitude;
        
        exifObj['GPS'][piexif.GPSIFD.GPSLatitudeRef] = lat > 0 ? 'N' : 'S';
        exifObj['GPS'][piexif.GPSIFD.GPSLatitude] = this.degToDmsRational(Math.abs(lat));
        exifObj['GPS'][piexif.GPSIFD.GPSLongitudeRef] = lon > 0 ? 'E' : 'W';
        exifObj['GPS'][piexif.GPSIFD.GPSLongitude] = this.degToDmsRational(Math.abs(lon));
        
        if (exifData.gpsData.altitude) {
          exifObj['GPS'][piexif.GPSIFD.GPSAltitude] = [exifData.gpsData.altitude * 100, 100];
          exifObj['GPS'][piexif.GPSIFD.GPSAltitudeRef] = exifData.gpsData.altitude >= 0 ? 0 : 1;
        }
      }
      
      // Convert EXIF object to bytes
      const exifBytes = piexif.dump(exifObj);
      
      // Insert EXIF into image
      const newJpegData = piexif.insert(exifBytes, jpegData);
      
      // Convert back to buffer
      const base64Data = newJpegData.split(',')[1];
      return Buffer.from(base64Data, 'base64');
      
    } catch (error: any) {
      console.error('Error writing EXIF data:', error);
      // If EXIF writing fails, return original with Sharp metadata only
      return this.fallbackToSharp(imageBuffer, exifData);
    }
  }
  
  /**
   * Read EXIF data from an image
   */
  static async readExifData(imageBuffer: Buffer): Promise<any> {
    try {
      const jpegData = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
      const exifObj = piexif.load(jpegData);
      
      const result: any = {
        copyright: exifObj['0th']?.[piexif.ImageIFD.Copyright],
        author: exifObj['0th']?.[piexif.ImageIFD.Artist],
        software: exifObj['0th']?.[piexif.ImageIFD.Software],
        description: exifObj['0th']?.[piexif.ImageIFD.ImageDescription],
        dateTime: exifObj['0th']?.[piexif.ImageIFD.DateTime],
        dateTimeOriginal: exifObj['Exif']?.[piexif.ExifIFD.DateTimeOriginal],
      };
      
      // Read GPS if exists
      if (exifObj['GPS'] && Object.keys(exifObj['GPS']).length > 0) {
        const gps = exifObj['GPS'];
        const lat = this.dmsRationalToDeg(
          gps[piexif.GPSIFD.GPSLatitude],
          gps[piexif.GPSIFD.GPSLatitudeRef]
        );
        const lon = this.dmsRationalToDeg(
          gps[piexif.GPSIFD.GPSLongitude],
          gps[piexif.GPSIFD.GPSLongitudeRef]
        );
        
        if (lat !== null && lon !== null) {
          result.gps = { latitude: lat, longitude: lon };
        }
      }
      
      // Read keywords if exist
      if (exifObj['0th']?.[piexif.ImageIFD.XPKeywords]) {
        const keywordsBytes = exifObj['0th'][piexif.ImageIFD.XPKeywords];
        const keywordsStr = Buffer.from(keywordsBytes).toString('utf16le').replace(/\0/g, '');
        result.keywords = keywordsStr.split(';').map(k => k.trim());
      }
      
      return result;
    } catch (error) {
      console.error('Error reading EXIF data:', error);
      return null;
    }
  }
  
  /**
   * Strip all EXIF data except orientation
   */
  static async stripExifData(imageBuffer: Buffer): Promise<Buffer> {
    try {
      // Get orientation from Sharp first
      const metadata = await sharp(imageBuffer).metadata();
      const orientation = metadata.orientation;
      
      // Convert to JPEG and strip EXIF
      const jpegBuffer = await sharp(imageBuffer)
        .jpeg()
        .toBuffer();
      
      const jpegData = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
      
      // Create minimal EXIF with only orientation
      const exifObj = {
        '0th': {},
        'Exif': {},
        'GPS': {},
        '1st': {},
        'thumbnail': null
      };
      
      if (orientation) {
        exifObj['0th'][piexif.ImageIFD.Orientation] = orientation;
      }
      
      const exifBytes = piexif.dump(exifObj);
      const newJpegData = piexif.insert(exifBytes, jpegData);
      
      const base64Data = newJpegData.split(',')[1];
      return Buffer.from(base64Data, 'base64');
      
    } catch (error) {
      console.error('Error stripping EXIF:', error);
      // Fallback to Sharp
      return sharp(imageBuffer)
        .withMetadata({ orientation: (await sharp(imageBuffer).metadata()).orientation })
        .toBuffer();
    }
  }
  
  /**
   * Fallback to Sharp for basic metadata
   */
  private static async fallbackToSharp(
    imageBuffer: Buffer,
    exifData: ExifData
  ): Promise<Buffer> {
    const metadata = await sharp(imageBuffer).metadata();
    
    const metadataOptions: any = {
      orientation: metadata.orientation
    };
    
    // Sharp's limited EXIF support
    if (exifData.copyright || exifData.author) {
      metadataOptions.exif = {
        IFD0: {
          Copyright: exifData.copyright || '',
          Artist: exifData.author || '',
          Software: exifData.software || 'AI Content Manager'
        }
      };
    }
    
    return sharp(imageBuffer)
      .withMetadata(metadataOptions)
      .toBuffer();
  }
  
  /**
   * Convert decimal degrees to DMS rational format for EXIF
   */
  private static degToDmsRational(deg: number): number[][] {
    const d = Math.floor(deg);
    const m = Math.floor((deg - d) * 60);
    const s = Math.round(((deg - d) * 60 - m) * 60 * 100);
    
    return [[d, 1], [m, 1], [s, 100]];
  }
  
  /**
   * Convert DMS rational format to decimal degrees
   */
  private static dmsRationalToDeg(dms: number[][], ref: string): number | null {
    if (!dms || dms.length !== 3) return null;
    
    const d = dms[0][0] / dms[0][1];
    const m = dms[1][0] / dms[1][1];
    const s = dms[2][0] / dms[2][1];
    
    let deg = d + m / 60 + s / 3600;
    
    if (ref === 'S' || ref === 'W') {
      deg = -deg;
    }
    
    return deg;
  }
}

// Updated processImageWithSharp function to use ExifHandler
export async function processImageWithSharpEnhanced(
  imageBuffer: Buffer,
  options: any
): Promise<Buffer> {
  let processedBuffer = imageBuffer;
  
  // Read existing EXIF data first
  const existingExif = await ExifHandler.readExifData(imageBuffer);
  console.log('Existing EXIF data:', existingExif);
  
  // Handle different actions
  if (options.action === 'strip') {
    console.log('  Stripping all EXIF data');
    processedBuffer = await ExifHandler.stripExifData(processedBuffer);
    
  } else if (options.action === 'add' || options.action === 'update') {
    console.log('  Writing EXIF data');
    
    const exifData: ExifData = {
      copyright: options.copyright,
      author: options.author,
      software: 'AI Content Manager',
      description: options.description || `Processed by ${options.author || 'AI Content Manager'}`,
      keywords: options.keywords || ['Murray Group', 'Real Estate', 'Quebec City'],
      dateTime: new Date()
    };
    
    // Remove GPS if requested
    if (options.removeGPS) {
      exifData.gpsData = { latitude: undefined, longitude: undefined };
    } else if (existingExif?.gps) {
      // Preserve existing GPS if not removing
      exifData.gpsData = existingExif.gps;
    }
    
    processedBuffer = await ExifHandler.writeExifData(processedBuffer, exifData);
    
  } else if (options.action === 'scramble') {
    // Your existing scramble logic
    console.log('  Applying scramble effect');
    // ... scrambling code ...
    
    // After scrambling, strip metadata for privacy
    processedBuffer = await ExifHandler.stripExifData(processedBuffer);
  }
  
  // Apply optimizations with Sharp
  if (options.optimize) {
    console.log('  Optimizing image');
    const metadata = await sharp(processedBuffer).metadata();
    let pipeline = sharp(processedBuffer);
    
    // Resize if needed
    if (options.maxWidth && metadata.width && metadata.width > options.maxWidth) {
      console.log(`  Resizing from ${metadata.width}px to ${options.maxWidth}px`);
      pipeline = pipeline.resize(options.maxWidth, null, {
        withoutEnlargement: true,
        fit: 'inside'
      });
    }
    
    // Apply format-specific optimizations
    const quality = options.quality || 85;
    pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
    
    processedBuffer = await pipeline.toBuffer();
  }
  
  // Verify EXIF was written
  const finalExif = await ExifHandler.readExifData(processedBuffer);
  console.log('Final EXIF data:', finalExif);
  
  console.log(`  Processed size: ${(processedBuffer.length / 1024).toFixed(1)}KB`);
  return processedBuffer;
}





