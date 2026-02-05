

import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { aiService } from "./services/ai-service";
import { seoService } from "./services/seo-service";
import { approvalWorkflowService } from "./services/approval-workflow";
import { insertWebsiteSchema, insertContentSchema, passwordResetTokens } from "@shared/schema";
import { eq, gt, desc, and, sql, count, gte } from 'drizzle-orm';
import { AuthService } from "./services/auth-service";
import { wordpressService } from "./services/wordpress-service";
import { wordPressAuthService } from './services/wordpress-auth';
import { aiFixService } from "./services/ai-fix-service";
import { apiValidationService } from "./services/api-validation";
import { imageProcessor } from './services/image-processor';
import { batchProcessMetadata, getImageStatus } from './api/images/batch-process';
import { imageService } from "./services/image-service";
import sharp from 'sharp';
import FormData from 'form-data';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { JSDOM } from 'jsdom';
import crypto from 'crypto';
import { ExifHandler, processImageWithSharpEnhanced } from './utils/exif-handler';
import { gscStorage } from "./services/gsc-storage";
import  gscRouter  from './routes/gsc.routes';
import multer from 'multer';
import { cloudinaryStorage } from "./services/cloudinary-storage";
import {db} from './db'
import { emailService } from './services/email-service';
import highIntentRoutes  from "./routes/high-intent-routes";
// import billingRouter from './routes/billing';

//added
import { schedulerService } from './services/scheduler-service';
import { users, websites, aiUsageTracking,  content, seoReports, activityLogs,googleAccounts, GoogleOAuthConfig } from "@shared/schema";
import { nanoBananaImagenService } from './services/nano-banana-imagen-service';
import nanoBananaImagenRoutes from "./routes/nano-banana-imagen-routes";




// Configure multer
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'));
    }
  }
});

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const authService = new AuthService();

// Add this near the top of server.ts, after your imports
function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


// ============================================================================
// VERIFICATION CODE STORE (In-memory - use Redis in production)
// ============================================================================
const verificationCodes = new Map<string, {
  code: string;
  username: string;
  expiresAt: Date;
  attempts: number;
}>();

// Clean up expired codes periodically (every 5 minutes)
setInterval(() => {
  const now = new Date();
  for (const [email, data] of verificationCodes.entries()) {
    if (data.expiresAt < now) {
      verificationCodes.delete(email);
    }
  }
}, 5 * 60 * 1000);

// =============================================================================
// TYPE DECLARATIONS & SESSION EXTENSIONS
// =============================================================================

declare global {
  namespace Express {
    interface Request {
      session?: {
        userId?: string;
        save: (callback: (err?: any) => void) => void;
        destroy: (callback: (err?: any) => void) => void;
      };
      user?: {
        id: string;
        username: string;
        email: string;
        name: string;
      };
    }
  }
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.session?.userId;
    if (!sessionId) {
      console.log('⌠ No session in requireAuth middleware');
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const user = await storage.getUser(sessionId);
    if (!user) {
      console.log('⌠ User not found in requireAuth middleware');
      req.session?.destroy(() => {});
      res.status(401).json({ message: "Invalid session" });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.status(500).json({ message: "Authentication error" });
  }
};


const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // First check if user is authenticated
    if (!req.session?.userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const user = await storage.getUser(req.session.userId);
    if (!user) {
      res.status(401).json({ message: "Invalid session" });
      return;
    }

    // Check if user is admin
    if (!user.isAdmin) {
      res.status(403).json({ message: "Admin access required" });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Admin middleware error:", error);
    res.status(500).json({ message: "Authorization error" });
  }
};


// =============================================================================
// HELPER FUNCTIONS - REPORTS
// =============================================================================

const generatePeriodString = (reportType: "weekly" | "monthly" | "quarterly", date?: Date): string => {
  const targetDate = date || new Date();
  
  switch (reportType) {
    case "weekly": {
      const startOfYear = new Date(targetDate.getFullYear(), 0, 1);
      const days = Math.floor((targetDate.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
      return `Week ${weekNumber}, ${targetDate.getFullYear()}`;
    }
    
    case "monthly": {
      const monthName = targetDate.toLocaleDateString("en-US", { month: "long" });
      return `${monthName} ${targetDate.getFullYear()}`;
    }
    
    case "quarterly": {
      const quarter = Math.floor(targetDate.getMonth() / 3) + 1;
      return `Q${quarter} ${targetDate.getFullYear()}`;
    }
    
    default:
      throw new Error(`Invalid report type: ${reportType}`);
  }
};

async function generateReportData(websiteId: string, reportType: string, userId: string) {
  console.log(`📊 Generating report data for website: ${websiteId}, type: ${reportType}`);
  
  const now = new Date();
  let startDate: Date;
  let period: string;

  if (reportType === 'weekly') {
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    period = `Week ${weekNumber}, ${now.getFullYear()}`;
  } else if (reportType === 'monthly') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    period = `${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
  } else {
    const quarter = Math.floor(now.getMonth() / 3) + 1;
    startDate = new Date(now.getFullYear(), (quarter - 1) * 3, 1);
    period = `Q${quarter} ${now.getFullYear()}`;
  }

  console.log(`📅 Report period: ${period} (from ${startDate.toISOString()})`);
  
  try {
    const existingReports = await storage.getClientReports(websiteId);
    const duplicateReport = existingReports.find(report => 
      report.reportType === reportType && report.period === period
    );
    
    if (duplicateReport) {
      console.log(`⚠️ Duplicate report found for ${period}, ${reportType}`);
      return {
        period: duplicateReport.period,
        data: duplicateReport.data,
        insights: duplicateReport.insights,
        roiData: duplicateReport.roiData
      };
    }
    
    const [content, seoReports, activityLogs] = await Promise.all([
      storage.getContentByWebsite(websiteId),
      storage.getSeoReportsByWebsite(websiteId, userId),
      storage.getActivityLogs(websiteId)
    ]);
    
    console.log(`📊 Data fetched - Content: ${content.length}, SEO Reports: ${seoReports.length}, Activity: ${activityLogs.length}`);
    
    const periodContent = content.filter(c => new Date(c.createdAt) >= startDate);
    const periodSeoReports = seoReports.filter(r => new Date(r.createdAt) >= startDate);
    const periodActivity = activityLogs.filter(a => new Date(a.createdAt) >= startDate);
    
    const publishedContent = periodContent.filter(c => c.status === 'published');
    const latestSeoReport = seoReports[0];
    const previousSeoReport = seoReports[1];
    
    const seoScoreChange = latestSeoReport && previousSeoReport ? 
      latestSeoReport.score - previousSeoReport.score : 0;
    
    const avgSeoScore = periodContent.length > 0 ? 
      Math.round(periodContent.reduce((sum, c) => sum + (c.seoScore || 0), 0) / periodContent.length) : 0;
    
    const avgReadabilityScore = periodContent.length > 0 ? 
      Math.round(periodContent.reduce((sum, c) => sum + (c.readabilityScore || 0), 0) / periodContent.length) : 0;
    
    const avgBrandVoiceScore = periodContent.length > 0 ? 
      Math.round(periodContent.reduce((sum, c) => sum + (c.brandVoiceScore || 0), 0) / periodContent.length) : 0;
    
    const totalCostCents = periodContent.reduce((sum, c) => sum + (c.costUsd || 0), 0);
    const totalImageCostCents = periodContent.reduce((sum, c) => sum + (c.imageCostCents || 0), 0);
    const totalTokens = periodContent.reduce((sum, c) => sum + (c.tokensUsed || 0), 0);
    const totalCostUsd = (totalCostCents + totalImageCostCents) / 100;
    
    const activeDays = periodActivity.length > 0 ? 
      new Set(periodActivity.map(a => a.createdAt.toDateString())).size : 0;
    
    const contentWithImages = periodContent.filter(c => c.hasImages).length;
    const totalImages = periodContent.reduce((sum, c) => sum + (c.imageCount || 0), 0);
    
    const insights = [];
    
    if (seoScoreChange > 5) {
      insights.push(`SEO score improved significantly by ${seoScoreChange.toFixed(1)} points this ${reportType}.`);
    } else if (seoScoreChange < -5) {
      insights.push(`SEO score declined by ${Math.abs(seoScoreChange).toFixed(1)} points - recommend immediate attention.`);
    } else if (Math.abs(seoScoreChange) <= 2) {
      insights.push(`SEO score remained stable with minimal change (${seoScoreChange >= 0 ? '+' : ''}${seoScoreChange.toFixed(1)} points).`);
    }
    
    if (publishedContent.length > 0) {
      insights.push(`Published ${publishedContent.length} pieces of content with an average SEO score of ${avgSeoScore}%.`);
      
      if (contentWithImages > 0) {
        insights.push(`${contentWithImages} content pieces included AI-generated images (${totalImages} total images).`);
      }
    } else {
      insights.push(`No content was published during this ${reportType} period.`);
    }
    
    if (avgBrandVoiceScore > 80) {
      insights.push(`Excellent brand voice consistency with ${avgBrandVoiceScore}% average score.`);
    } else if (avgBrandVoiceScore > 60) {
      insights.push(`Good brand voice alignment with ${avgBrandVoiceScore}% average score.`);
    } else if (avgBrandVoiceScore > 0) {
      insights.push(`Brand voice needs improvement - current average: ${avgBrandVoiceScore}%.`);
    }
    
    if (totalCostUsd > 0) {
      const textCost = totalCostCents / 100;
      const imageCost = totalImageCostCents / 100;
      if (imageCost > 0) {
        insights.push(`AI generation cost: $${totalCostUsd.toFixed(2)} total ($${textCost.toFixed(2)} content + $${imageCost.toFixed(2)} images) for ${totalTokens.toLocaleString()} tokens.`);
      } else {
        insights.push(`AI content generation cost: $${textCost.toFixed(2)} for ${totalTokens.toLocaleString()} tokens.`);
      }
    }
    
    if (activeDays > 0) {
      const activityRate = (activeDays / ((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))) * 100;
      insights.push(`Active on ${activeDays} days (${activityRate.toFixed(0)}% activity rate) during this period.`);
    }
    
    const data = {
      seoScoreChange: Math.round(seoScoreChange * 10) / 10,
      currentSeoScore: latestSeoReport?.score || 0,
      previousSeoScore: previousSeoReport?.score || 0,
      contentPublished: publishedContent.length,
      contentTotal: periodContent.length,
      avgSeoScore,
      avgReadabilityScore,
      avgBrandVoiceScore,
      totalCostUsd,
      textCostUsd: totalCostCents / 100,
      imageCostUsd: totalImageCostCents / 100,
      totalTokens,
      activeDays,
      contentWithImages,
      totalImages,
      pageViews: null,
      organicTraffic: null,
      conversionRate: null,
      backlinks: null,
      keywordRankings: null,
      hasAnalytics: false,
      hasSeoTools: false,
      dataNote: "Traffic and ranking data requires analytics integration"
    };
    
    const roiData = {
      contentROI: publishedContent.length > 0 && totalCostUsd > 0 ? 
        Math.round((publishedContent.length * 50) / totalCostUsd) : 0,
      timeInvested: publishedContent.length * 30,
      costPerContent: publishedContent.length > 0 ? 
        Math.round((totalCostUsd / publishedContent.length) * 100) / 100 : 0,
      costEfficiency: totalTokens > 0 ? 
        Math.round((totalTokens / (totalCostUsd * 100)) * 100) / 100 : 0
    };
    
    console.log(`✅ FACTUAL report data generated:`, { 
      period, 
      contentCount: periodContent.length, 
      publishedCount: publishedContent.length,
      seoScoreChange: data.seoScoreChange,
      totalCostUsd: data.totalCostUsd,
      activeDays: data.activeDays,
      hasImages: contentWithImages > 0
    });
    
    return {
      period,
      data,
      insights,
      roiData
    };
    
  } catch (error) {
    console.error("Error generating FACTUAL report data:", error);
    throw error;
  }
}

function generateIterativeFixRecommendations(result: any): string[] {
  const recommendations: string[] = [];
  
  if (result.stoppedReason === 'target_reached') {
    recommendations.push(`🎉 Excellent work! Your website now has a ${result.finalScore}/100 SEO score.`);
    recommendations.push("Monitor your SEO score weekly to maintain this performance.");
    if (result.finalScore < 95) {
      recommendations.push("Consider running a detailed content audit to reach 95+ score.");
    }
  } else if (result.stoppedReason === 'max_iterations') {
    recommendations.push(`Reached maximum iterations. Score improved by ${result.scoreImprovement.toFixed(1)} points.`);
    recommendations.push("Consider running the process again after addressing remaining critical issues manually.");
    recommendations.push("Review technical SEO elements that require manual intervention.");
  } else if (result.stoppedReason === 'no_improvement') {
    recommendations.push("Score improvement plateaued. Consider manual optimization for remaining issues.");
    recommendations.push("Focus on content quality improvements and technical SEO elements.");
    recommendations.push("Review website structure and user experience factors.");
  } else if (result.stoppedReason === 'error') {
    recommendations.push("Process encountered errors. Check website accessibility and try again.");
    recommendations.push("Review error logs for specific issues that need manual attention.");
  }
  
  if (result.finalScore < 70) {
    recommendations.push("Focus on critical SEO issues: meta descriptions, title tags, and image optimization.");
  } else if (result.finalScore < 85) {
    recommendations.push("Work on advanced SEO: internal linking, content structure, and technical optimization.");
  }
  
  if (result.iterationsCompleted > 0) {
    const avgImprovement = result.scoreImprovement / result.iterationsCompleted;
    if (avgImprovement > 5) {
      recommendations.push(`Strong improvement trend (+${avgImprovement.toFixed(1)} points/iteration). Keep up the momentum!`);
    } else if (avgImprovement > 2) {
      recommendations.push(`Steady improvement (+${avgImprovement.toFixed(1)} points/iteration). Consider focusing on high-impact fixes.`);
    }
  }
  
  return recommendations;
}

// =============================================================================
// HELPER FUNCTIONS - IMAGE PROCESSING
// =============================================================================

async function findMediaIdFromUrl(baseUrl: string, imageUrl: string, authHeader?: string): Promise<string | null> {
  try {
    const urlParts = imageUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    const originalFilename = filename.replace(/-\d+x\d+(\.\w+)$/, '$1');
    
    console.log(`  Searching for media with filename: ${originalFilename}`);
    
    const searchUrl = `${baseUrl}/wp-json/wp/v2/media?search=${encodeURIComponent(originalFilename)}&per_page=100`;
    
    const headers: any = {};
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }
    
    const response = await fetch(searchUrl, { headers });
    
    if (response.ok) {
      const mediaItems = await response.json();
      
      for (const media of mediaItems) {
        if (media.source_url && (
          media.source_url === imageUrl ||
          media.source_url.includes(originalFilename) ||
          imageUrl.includes(media.slug)
        )) {
          console.log(`  Found media ID: ${media.id}`);
          return media.id.toString();
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('  Error searching for media ID:', error);
    return null;
  }
}

async function processImageWithSharp(imageBuffer: Buffer, options: any): Promise<Buffer> {
  let pipeline = sharp(imageBuffer);
  
  const metadata = await pipeline.metadata();
  
  // Handle scrambling action
  if (options.action === 'scramble') {
    console.log(`  Applying scramble: ${options.scrambleType} at ${options.scrambleIntensity}% intensity`);
    
    switch (options.scrambleType) {
      case 'pixel-shift':
        pipeline = await applyPixelShift(pipeline, metadata, options.scrambleIntensity || 50);
        break;
      case 'watermark':
        pipeline = await applyWatermark(pipeline, metadata, options);
        break;
      case 'blur-regions':
        pipeline = await applyBlurRegions(pipeline, metadata, options);
        break;
      case 'color-shift':
        pipeline = await applyColorShift(pipeline, metadata, options.scrambleIntensity || 50);
        break;
      case 'noise':
        pipeline = await applyNoise(pipeline, metadata, options.scrambleIntensity || 50);
        break;
    }
    
    pipeline = pipeline.withMetadata({
      orientation: metadata.orientation
    });
    
  } else if (options.action === 'strip') {
    console.log('  Stripping metadata');
    pipeline = pipeline.withMetadata({
      orientation: metadata.orientation
    });
    
  } else if (options.action === 'add' || options.action === 'update') {
    console.log('  Adding/updating metadata');
    
    const metadataOptions: any = {
      orientation: metadata.orientation
    };
    
    if (options.copyright || options.author) {
      try {
        metadataOptions.exif = {
          IFD0: {
            Copyright: options.copyright || '',
            Artist: options.author || '',
            Software: 'AI Content Manager',
            DateTime: new Date().toISOString().split('T')[0].replace(/-/g, ':') + ' ' + 
                     new Date().toISOString().split('T')[1].split('.')[0]
          }
        };
        
        if (metadata.exif) {
          try {
            const existingExif = await sharp(metadata.exif).metadata();
            metadataOptions.exif = {
              ...existingExif,
              ...metadataOptions.exif
            };
          } catch (e) {
            console.log('  Could not preserve existing EXIF');
          }
        }
      } catch (e) {
        console.log('  Warning: Could not add full metadata:', e);
      }
    }
    
    pipeline = pipeline.withMetadata(metadataOptions);
  }
  
  if (options.optimize) {
    console.log('  Optimizing image');
    
    if (options.maxWidth && metadata.width && metadata.width > options.maxWidth) {
      console.log(`  Resizing from ${metadata.width}px to ${options.maxWidth}px`);
      pipeline = pipeline.resize(options.maxWidth, null, {
        withoutEnlargement: true,
        fit: 'inside'
      });
    }
    
    const quality = options.quality || 85;
    
    if (metadata.format === 'png') {
      const stats = await sharp(imageBuffer).stats();
      const channels = stats.channels.length;
      const hasTransparency = channels === 4;
      
      if (!hasTransparency && metadata.density && metadata.density > 72) {
        console.log('  Converting PNG photo to JPEG');
        pipeline = pipeline.jpeg({
          quality,
          progressive: true,
          mozjpeg: true
        });
      } else {
        console.log('  Optimizing PNG');
        pipeline = pipeline.png({
          quality,
          compressionLevel: 9,
          palette: true
        });
      }
    } else if (metadata.format === 'webp') {
      console.log('  Optimizing WebP');
      pipeline = pipeline.webp({
        quality,
        effort: 6,
        lossless: false
      });
    } else {
      console.log('  Optimizing JPEG');
      pipeline = pipeline.jpeg({
        quality,
        progressive: true,
        mozjpeg: true
      });
    }
  }
  
  if (options.removeGPS && options.action !== 'strip') {
    console.log('  Removing GPS data');
    const currentMeta = await pipeline.metadata();
    pipeline = pipeline.withMetadata({
      orientation: currentMeta.orientation
    });
  }
  
  if (!options.keepColorProfile) {
    console.log('  Converting to sRGB');
    pipeline = pipeline.toColorspace('srgb');
  }
  
  const processedBuffer = await pipeline.toBuffer();
  console.log(`  Processed size: ${(processedBuffer.length / 1024).toFixed(1)}KB`);
  
  return processedBuffer;
}

// =============================================================================
// HELPER FUNCTIONS - IMAGE SCRAMBLING
// =============================================================================

async function applyPixelShift(pipeline: sharp.Sharp, metadata: sharp.Metadata, intensity: number): Promise<sharp.Sharp> {
  const { width = 100, height = 100 } = metadata;
  
  const shiftAmount = Math.floor((intensity / 100) * Math.min(width, height) * 0.1);
  
  const { data, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const blockSize = Math.max(4, Math.floor(Math.min(width, height) / 20));
  const scrambledData = Buffer.from(data);
  
  for (let y = 0; y < height - blockSize; y += blockSize) {
    for (let x = 0; x < width - blockSize; x += blockSize) {
      if (Math.random() < intensity / 100) {
        const targetX = Math.floor(Math.random() * (width - blockSize));
        const targetY = Math.floor(Math.random() * (height - blockSize));
        
        for (let by = 0; by < blockSize; by++) {
          for (let bx = 0; bx < blockSize; bx++) {
            const sourceIdx = ((y + by) * width + (x + bx)) * info.channels;
            const targetIdx = ((targetY + by) * width + (targetX + bx)) * info.channels;
            
            if (sourceIdx < scrambledData.length && targetIdx < scrambledData.length) {
              for (let c = 0; c < info.channels; c++) {
                const temp = scrambledData[sourceIdx + c];
                scrambledData[sourceIdx + c] = scrambledData[targetIdx + c];
                scrambledData[targetIdx + c] = temp;
              }
            }
          }
        }
      }
    }
  }
  
  return sharp(scrambledData, {
    raw: {
      width,
      height,
      channels: info.channels
    }
  });
}

async function applyWatermark(pipeline: sharp.Sharp, metadata: sharp.Metadata, options: any): Promise<sharp.Sharp> {
  const { width = 800, height = 600 } = metadata;
  const text = options.watermarkText || 'CONFIDENTIAL';
  const fontSize = Math.floor(Math.min(width, height) / 10);
  
  const watermarkSvg = `
    <svg width="${width}" height="${height}">
      <style>
        .watermark { 
          fill: rgba(255, 0, 0, 0.4); 
          font-size: ${fontSize}px; 
          font-family: Arial, sans-serif; 
          font-weight: bold;
        }
      </style>
      <text x="50%" y="50%" 
        text-anchor="middle" 
        dominant-baseline="middle" 
        transform="rotate(-45, ${width/2}, ${height/2})"
        class="watermark">
        ${text}
      </text>
    </svg>
  `;
  
  return pipeline.composite([{
    input: Buffer.from(watermarkSvg),
    gravity: options.watermarkPosition === 'top-left' ? 'northwest' :
             options.watermarkPosition === 'top-right' ? 'northeast' :
             options.watermarkPosition === 'bottom-left' ? 'southwest' :
             options.watermarkPosition === 'bottom-right' ? 'southeast' : 'center',
    blend: 'over'
  }]);
}

async function applyBlurRegions(pipeline: sharp.Sharp, metadata: sharp.Metadata, options: any): Promise<sharp.Sharp> {
  const { width = 800, height = 600 } = metadata;
  const numRegions = Math.floor((options.scrambleIntensity || 50) / 10);
  
  const baseBuffer = await pipeline.toBuffer();
  let compositePipeline = sharp(baseBuffer);
  
  const overlays: sharp.OverlayOptions[] = [];
  
  for (let i = 0; i < numRegions; i++) {
    const regionWidth = Math.floor(width * (0.1 + Math.random() * 0.2));
    const regionHeight = Math.floor(height * (0.1 + Math.random() * 0.2));
    const x = Math.floor(Math.random() * (width - regionWidth));
    const y = Math.floor(Math.random() * (height - regionHeight));
    
    const blurredRegion = await sharp(baseBuffer)
      .extract({ left: x, top: y, width: regionWidth, height: regionHeight })
      .blur(20)
      .toBuffer();
    
    overlays.push({
      input: blurredRegion,
      left: x,
      top: y
    });
  }
  
  if (overlays.length > 0) {
    compositePipeline = compositePipeline.composite(overlays);
  }
  
  return compositePipeline;
}

async function applyColorShift(pipeline: sharp.Sharp, metadata: sharp.Metadata, intensity: number): Promise<sharp.Sharp> {
  const shift = (intensity / 100) * 180;
  
  return pipeline
    .modulate({
      hue: shift,
      saturation: 1 + (Math.random() - 0.5) * (intensity / 100),
      brightness: 1 + (Math.random() - 0.5) * (intensity / 200)
    })
    .tint({
      r: Math.floor(Math.random() * intensity),
      g: Math.floor(Math.random() * intensity),
      b: Math.floor(Math.random() * intensity)
    });
}

async function applyNoise(pipeline: sharp.Sharp, metadata: sharp.Metadata, intensity: number): Promise<sharp.Sharp> {
  const { width = 800, height = 600 } = metadata;
  
  const noiseIntensity = Math.floor((intensity / 100) * 50);
  const noiseBuffer = Buffer.alloc(width * height * 4);
  
  for (let i = 0; i < noiseBuffer.length; i += 4) {
    const noise = Math.floor(Math.random() * noiseIntensity);
    noiseBuffer[i] = noise;
    noiseBuffer[i + 1] = noise;
    noiseBuffer[i + 2] = noise;
    noiseBuffer[i + 3] = 128;
  }
  
  const noiseImage = await sharp(noiseBuffer, {
    raw: {
      width,
      height,
      channels: 4
    }
  }).png().toBuffer();
  
  return pipeline.composite([{
    input: noiseImage,
    blend: 'overlay'
  }]);
}

// =============================================================================
// MAIN ROUTE REGISTRATION FUNCTION
// =============================================================================

export async function registerRoutes(app: Express): Promise<Server> {
  
  // ===========================================================================
  // AUTHENTICATION ROUTES
  // ===========================================================================
  

app.post("/api/auth/signup", async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🔐 Signup request received:', {
      body: req.body,
      hasUsername: !!req.body.username,
      hasPassword: !!req.body.password,
      hasEmail: !!req.body.email,
      hasVerificationCode: !!req.body.verificationCode
    });

    const { username, password, email, name, verificationCode } = req.body;

    if (!username || !password || !email) {
      console.error('❌ Missing required fields');
      res.status(400).json({ 
        message: "Username, password, and email are required",
        errors: ['Username is required', 'Password is required', 'Email is required'].filter((msg, i) => 
          i === 0 ? !username : i === 1 ? !password : !email
        )
      });
      return;
    }

    // Check verification code if provided
    if (verificationCode) {
      const stored = verificationCodes.get(email.toLowerCase());
      
      if (!stored) {
        res.status(400).json({ 
          message: "No verification code found. Please request a new code." 
        });
        return;
      }
      
      if (stored.expiresAt < new Date()) {
        verificationCodes.delete(email.toLowerCase());
        res.status(400).json({ 
          message: "Verification code expired. Please request a new code." 
        });
        return;
      }
      
      if (stored.code !== verificationCode.trim()) {
        stored.attempts++;
        if (stored.attempts >= 5) {
          verificationCodes.delete(email.toLowerCase());
          res.status(400).json({ 
            message: "Too many failed attempts. Please request a new code." 
          });
        } else {
          res.status(400).json({ 
            message: `Invalid verification code. ${5 - stored.attempts} attempts remaining.` 
          });
        }
        return;
      }
      
      // Verify username matches
      if (stored.username !== username) {
        res.status(400).json({ 
          message: "Username doesn't match verification request" 
        });
        return;
      }
      
      // Code is valid - remove from store
      verificationCodes.delete(email.toLowerCase());
      console.log('✅ Verification code validated for:', email);
    }

    // Validate user data
    const validation = authService.validateUserData({ username, password, email, name });
    if (validation.length > 0) {
      console.error('❌ Validation errors:', validation);
      res.status(400).json({ 
        message: "Validation failed", 
        errors: validation 
      });
      return;
    }

    console.log('👤 Creating user...');
    const user = await authService.createUser({ username, password, email, name });
    console.log('✅ User created:', { id: user.id, username: user.username });
    
    if (req.session) {
      req.session.userId = user.id;
      req.session.save((err) => {
        if (err) {
          console.error("❌ Session save error:", err);
          res.status(500).json({ message: "Failed to create session" });
          return;
        }

        console.log('✅ Session created for user:', user.id);

        res.status(201).json({
          success: true,
          message: "Account created successfully",
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            name: user.name
          }
        });
      });
    } else {
      console.error('❌ No session available');
      res.status(500).json({ message: "Session not configured" });
    }
  } catch (error) {
    console.error("❌ Signup error:", error);
    
    if (error instanceof Error) {
      if (error.message.includes('already exists')) {
        res.status(409).json({ message: error.message });
        return;
      }
      
      if (error.message.includes('Validation failed')) {
        res.status(400).json({ message: error.message });
        return;
      }
    }
    
    res.status(500).json({ message: "Failed to create account" });
  }
});

  app.post("/api/auth/login", async (req: Request, res: Response): Promise<void> => {
    try {
      console.log('🔐 Login request received:', {
        hasUsername: !!req.body.username,
        hasPassword: !!req.body.password,
        username: req.body.username
      });

      const { username, password } = req.body;

      if (!username || !password) {
        console.error('⌠ Missing login credentials');
        res.status(400).json({ message: "Username and password are required" });
        return;
      }

      console.log('🔐 Authenticating user...');
      const user = await authService.authenticateUser(username, password);
      console.log('✅ Authentication successful:', user.username);
      
      if (req.session) {
        req.session.userId = user.id;
        req.session.save((err) => {
          if (err) {
            console.error("⌠ Session save error:", err);
            res.status(500).json({ message: "Failed to create session" });
            return;
          }

          console.log('✅ Session created for login:', user.id);

          res.json({
            success: true,
            message: "Login successful",
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              name: user.name
            }
          });
        });
      } else {
        console.error('⌠ No session available for login');
        res.status(500).json({ message: "Session not configured" });
      }
    } catch (error) {
      console.error("⌠ Login error:", error);
      
      if (error instanceof Error && error.message.includes('Invalid username or password')) {
        res.status(401).json({ message: "Invalid username or password" });
        return;
      }
      
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.session?.userId;
      
      req.session?.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
          res.status(500).json({ message: "Failed to logout" });
          return;
        }
        
        res.clearCookie('connect.sid');
        res.json({ 
          success: true, 
          message: "Logged out successfully" 
        });
      });
    } catch (error) {
      console.error("Logout error:", error);
      res.status(500).json({ message: "Logout failed" });
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response): Promise<void> => {
    try {
      console.log('👤 Auth check request, session:', {
        hasSession: !!req.session,
        userId: req.session?.userId
      });

      const sessionId = req.session?.userId;
      if (!sessionId) {
        console.log('⌠ No session ID found');
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const user = await storage.getUser(sessionId);
      if (!user) {
        console.log('⌠ User not found for session:', sessionId);
        req.session?.destroy(() => {});
        res.status(401).json({ message: "Invalid session" });
        return;
      }

      console.log('✅ User found:', { id: user.id, username: user.username });

      res.json({
        id: user.id,
        username: user.username,
        email: user.email || null,
        name: user.name || null,
        isAdmin: user.isAdmin || false
      });
    } catch (error) {
      console.error("⌠ Auth check error:", error);
      res.status(500).json({ message: "Authentication error" });
    }
  });

  app.post("/api/auth/change-password", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const { currentPassword, newPassword, confirmPassword } = req.body;
      
      console.log(`🔐 Password change request for user: ${userId}`);
      
      if (!currentPassword || !newPassword || !confirmPassword) {
        res.status(400).json({ 
          message: "Current password, new password, and confirmation are required" 
        });
        return;
      }
      
      if (newPassword !== confirmPassword) {
        res.status(400).json({ 
          message: "New password and confirmation do not match" 
        });
        return;
      }
      
      const passwordValidation = authService.validatePassword(newPassword);
      if (passwordValidation.length > 0) {
        res.status(400).json({ 
          message: "Password does not meet requirements",
          errors: passwordValidation
        });
        return;
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      
      const isCurrentPasswordValid = await authService.verifyPassword(currentPassword, user.password);
      if (!isCurrentPasswordValid) {
        res.status(400).json({ 
          message: "Current password is incorrect" 
        });
        return;
      }
      
      const isSamePassword = await authService.verifyPassword(newPassword, user.password);
      if (isSamePassword) {
        res.status(400).json({ 
          message: "New password must be different from current password" 
        });
        return;
      }
      
      const hashedNewPassword = await authService.hashPassword(newPassword);
      
      const updatedUser = await authService.updateUserPassword(userId, hashedNewPassword);
      
      if (!updatedUser) {
        res.status(500).json({ message: "Failed to update password" });
        return;
      }
      
      await storage.createActivityLog({
        userId,
        type: "password_changed",
        description: "User password changed successfully",
        metadata: { 
          timestamp: new Date().toISOString(),
          ipAddress: req.ip || 'unknown'
        }
      });
      
      await storage.createSecurityAudit({
        userId,
        action: "password_change",
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        success: true,
        metadata: {
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`✅ Password changed successfully for user: ${userId}`);
      
      res.json({
        success: true,
        message: "Password changed successfully"
      });
      
    } catch (error) {
      console.error("Password change error:", error);
      
      try {
        await storage.createSecurityAudit({
          userId: req.user?.id,
          action: "password_change_failed",
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          success: false,
          metadata: {
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString()
          }
        });
      } catch (logError) {
        console.error("Failed to log security audit:", logError);
      }
      
      res.status(500).json({ 
        message: "Failed to change password",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

//for email verification(signup)
// Add this after the signup endpoint in routes.ts

app.post("/api/auth/send-verification", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, username } = req.body;
    
    console.log('📧 Sending verification code to:', email);
    
    // Validate inputs
    if (!email || !username) {
      res.status(400).json({ 
        message: "Email and username are required" 
      });
      return;
    }
    
    // Check if username already exists
    const existingUser = await storage.getUserByUsername(username);
    if (existingUser) {
      res.status(409).json({ 
        message: "Username already exists" 
      });
      return;
    }
    
    // Check if email already exists
    const existingEmail = await storage.getUserByEmail(email);
    if (existingEmail) {
      res.status(409).json({ 
        message: "Email already registered" 
      });
      return;
    }
    
    // Generate 6-digit verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store in memory
    verificationCodes.set(email.toLowerCase(), {
      code: verificationCode,
      username,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      attempts: 0
    });
    
    // Send email with verification code
    try {
      const emailSent = await emailService.sendVerificationCode(email, verificationCode);
      
      if (emailSent) {
        console.log('✅ Verification email sent to:', email);
      } else {
        console.warn('⚠️ Failed to send email, but code was generated');
      }
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
      // In development, return the code for testing
      if (process.env.NODE_ENV === 'development') {
        res.json({
          success: true,
          message: "Verification code generated",
          devCode: verificationCode // Only in development
        });
        return;
      }
    }
    
    res.json({
      success: true,
      message: "Verification code sent to your email"
    });
    
  } catch (error) {
    console.error("Send verification error:", error);
    res.status(500).json({ 
      message: "Failed to send verification code" 
    });
  }
});


















// ================================================
// GOOGLE OAUTH ROUTES
// ================================================

/**
 * GET /api/auth/google/url
 * Returns the Google OAuth authorization URL
 */
app.get("/api/auth/google/url", async (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const redirectUri = process.env.GOOGLE_REDIRECT_AUTH_URI!;

    if (!clientId || !redirectUri) {
      return res.status(500).json({
        success: false,
        message: "Google OAuth is not configured",
      });
    }

    // CSRF protection state
    const state = crypto.randomBytes(32).toString("hex");
    req.session.oauthState = state;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });

    res.json({
      success: true,
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    });
  } catch (err) {
    console.error("Error generating Google OAuth URL:", err);
    res.status(500).json({
      success: false,
      message: "Failed to generate OAuth URL",
    });
  }
});






app.get("/api/auth/google/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";

    if (error) {
      console.error("Google OAuth error:", error);
      return res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("Authentication failed")}`);
    }

    // CSRF check
    if (!state || state !== req.session.oauthState) {
      return res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("Invalid state parameter")}`);
    }
    delete req.session.oauthState;

    if (!code) {
      return res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("No authorization code received")}`);
    }

    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectUri = process.env.GOOGLE_REDIRECT_AUTH_URI!;

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      console.error("Token exchange failed:", text);
      return res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("Failed to exchange authorization code")}`);
    }

    const { access_token, refresh_token, expires_in } = await tokenResponse.json();

    // Fetch Google user info
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userInfoResponse.ok) {
      return res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("Failed to fetch user info")}`);
    }

    const { id: googleId, email, name, picture } = await userInfoResponse.json();

    // Check if Google account exists
    let existingGoogleAccount = await db.select().from(googleAccounts).where(eq(googleAccounts.googleId, googleId)).limit(1);
    let user;

    if (existingGoogleAccount.length > 0) {
      const googleAccount = existingGoogleAccount[0];
      await db.update(googleAccounts)
        .set({
          accessToken: access_token,
          refreshToken: refresh_token || googleAccount.refreshToken,
          tokenExpiry: new Date(Date.now() + expires_in * 1000),
          updatedAt: new Date(),
        })
        .where(eq(googleAccounts.id, googleAccount.id));

      const userResult = await db.select().from(users).where(eq(users.id, googleAccount.userId)).limit(1);
      if (userResult.length === 0) {
        return res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("User account not found")}`);
      }
      user = userResult[0];
    } else {
      const existingUserByEmail = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existingUserByEmail.length > 0) {
        user = existingUserByEmail[0];
      } else {
        const usernameBase = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_.-]/g, "");
        let username = usernameBase;
        let counter = 1;
        while ((await db.select().from(users).where(eq(users.username, username)).limit(1)).length > 0) {
          username = `${usernameBase}${counter}`;
          counter++;
        }

        const newUsers = await db.insert(users).values({
          username,
          email,
          name,
          password: crypto.randomBytes(32).toString("hex"),
          emailVerified: true,
          isActive: true,
        }).returning();

        user = newUsers[0];
      }

      await db.insert(googleAccounts).values({
        userId: user.id,
        googleId,
        email,
        name,
        picture,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiry: new Date(Date.now() + expires_in * 1000),
        isActive: true,
      });
    }

    // Set session - CRITICAL: Wait for save to complete
    req.session.userId = user.id;
    req.session.isAuthenticated = true;
    
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error("Session save error:", err);
          reject(err);
        } else {
          console.log("Session saved successfully for user:", user.id);
          resolve();
        }
      });
    });

    // Redirect back to Vercel frontend
    res.redirect(clientUrl);

  } catch (err) {
    console.error("Google OAuth callback error:", err);
    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    res.redirect(`${clientUrl}/auth?google_error=${encodeURIComponent("Authentication failed")}`);
  }
});



app.post("/api/auth/google/unlink", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Not authenticated" });

    const user = await db.select().from(users).where(eq(users.id, req.session.userId)).limit(1);
    if (user.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    if (!user[0].password || user[0].password.length < 10) {
      return res.status(400).json({ success: false, message: "Set a password first to unlink Google" });
    }

    await db.delete(googleAccounts).where(eq(googleAccounts.userId, req.session.userId));
    res.json({ success: true, message: "Google account unlinked successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to unlink Google account" });
  }
});

/**
 * GET /api/auth/google/status
 * Check if user has a linked Google account
 */
app.get("/api/auth/google/status", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Not authenticated" });

    const googleAccount = await db.select({
      id: googleAccounts.id,
      email: googleAccounts.email,
      name: googleAccounts.name,
      picture: googleAccounts.picture,
      isActive: googleAccounts.isActive,
    }).from(googleAccounts).where(eq(googleAccounts.userId, req.session.userId)).limit(1);

    res.json({ success: true, linked: googleAccount.length > 0, account: googleAccount[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to check Google account status" });
  }
});



// ===========================================================================
// PASSWORD RESET ROUTES
// ===========================================================================


app.post("/api/auth/forgot-password", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    
    console.log('🔑 Password reset request for email:', email);
    
    // Validation
    if (!email) {
      res.status(400).json({ 
        message: "Email address is required" 
      });
      return;
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({ 
        message: "Please enter a valid email address" 
      });
      return;
    }
    
    const user = await storage.getUserByEmail(email);
    
    if (!user) {
        console.log('⚠️ User not found for email:', email);
        res.status(404).json({  // ← Returns 404 Not Found
          success: false,  // ← Says failure
          message: "No account found with this email address"
        });
        return;
      }
    
    // Generate and store code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedCode = crypto.createHash('sha256').update(verificationCode).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    // Clear any existing tokens for this user
    await db
      .delete(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          eq(passwordResetTokens.used, false)
        )
      );
    
    // Store new reset token
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      email: user.email,
      token: hashedCode,
      expiresAt,
      used: false,
      metadata: {
        type: 'verification_code',
        attempts: 0,
        verified: false,
        codeLength: 6
      }
    });

    // SEND EMAIL WITH VERIFICATION CODE
    try {
      const emailSent = await emailService.sendPasswordResetCode(user.email, verificationCode);
      
      if (emailSent) {
        console.log('✅ Verification code email sent to:', user.email);
      } else {
        console.warn('⚠️ Failed to send email, but code was generated');
        // In production, you might want to return an error here
        // But for development, continue so the code can still be used
      }
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
      // Continue anyway - in development, user can see code in response
    }

    // Log the activity
    await storage.createActivityLog({
      userId: user.id,
      type: "password_reset_requested",
      description: "Password reset code requested",
      metadata: { 
        email: user.email,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip || 'unknown'
      }
    });

    console.log('🔐 Verification code generated for:', user.email);

    // Response
    const responseData: any = {
      success: true,
      message: "If an account exists with that email, a verification code has been sent."
    };
    
    // Only include sensitive data in development mode
    if (process.env.NODE_ENV === 'development') {
      responseData.verificationCode = verificationCode;
      responseData.email = user.email;
      responseData.expiresAt = expiresAt.toISOString();
      responseData.devNote = "Code exposed only in development mode";
      console.log('📧 Dev Mode - Verification Code:', verificationCode);
    }
    
    res.json(responseData);
    
  } catch (error) {
    console.error("Password reset request error:", error);
    res.status(500).json({ 
      message: "An error occurred. Please try again later." 
    });
  }
});

app.post("/api/auth/verify-code", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, code } = req.body;
    
    console.log('🔍 Verifying reset code for email:', email);
    
    if (!email || !code) {
      res.status(400).json({ 
        valid: false,
        message: "Email and verification code are required" 
      });
      return;
    }

    // Find user by email
    const user = await storage.getUserByEmail(email);
    
    if (!user) {
      res.status(400).json({ 
        valid: false,
        message: "Invalid email or code" 
      });
      return;
    }

    // Hash the provided code
    const hashedCode = crypto.createHash('sha256').update(code).digest('hex');
    
    // Find valid reset token
    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          eq(passwordResetTokens.token, hashedCode),
          eq(passwordResetTokens.used, false),
          gt(passwordResetTokens.expiresAt, new Date())
        )
      )
      .limit(1);
    
    if (!resetToken) {
      // Increment failed attempts for the most recent token
      const [latestToken] = await db
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.userId, user.id),
            eq(passwordResetTokens.used, false)
          )
        )
        .orderBy(desc(passwordResetTokens.createdAt))
        .limit(1);
      
      if (latestToken) {
        const currentAttempts = (latestToken.metadata as any)?.attempts || 0;
        
        // Update attempts count
        await db
          .update(passwordResetTokens)
          .set({
            metadata: {
              ...(latestToken.metadata as any || {}),
              attempts: currentAttempts + 1,
              lastAttemptAt: new Date().toISOString()
            }
          })
          .where(eq(passwordResetTokens.id, latestToken.id));
        
        // Check if too many attempts
        if (currentAttempts >= 4) { // 5 total attempts
          // Mark as used to invalidate it
          await db
            .update(passwordResetTokens)
            .set({ 
              used: true,
              usedAt: new Date(),
              metadata: {
                ...(latestToken.metadata as any || {}),
                invalidatedReason: 'too_many_attempts'
              }
            })
            .where(eq(passwordResetTokens.id, latestToken.id));
          
          await storage.createSecurityAudit({
            userId: user.id,
            action: "password_reset_blocked",
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            success: false,
            metadata: {
              reason: "Too many failed attempts",
              email: user.email,
              timestamp: new Date().toISOString()
            }
          });
          
          res.status(400).json({ 
            valid: false,
            message: "Too many failed attempts. Please request a new code." 
          });
          return;
        }
      }
      
      res.status(400).json({ 
        valid: false,
        message: "Invalid or expired verification code" 
      });
      return;
    }

    // Code is valid - mark it as verified in metadata
    await db
      .update(passwordResetTokens)
      .set({
        metadata: {
          ...(resetToken.metadata as any || {}),
          verified: true,
          verifiedAt: new Date().toISOString()
        }
      })
      .where(eq(passwordResetTokens.id, resetToken.id));
    
    // Log successful verification
    await storage.createActivityLog({
      userId: user.id,
      type: "password_reset_code_verified",
      description: "Password reset code verified successfully",
      metadata: { 
        email: user.email,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip || 'unknown'
      }
    });

    res.json({
      valid: true,
      message: "Code verified successfully",
      // Return the token ID as session reference
      resetTokenId: resetToken.id
    });

  } catch (error) {
    console.error("Code verification error:", error);
    res.status(500).json({ 
      valid: false,
      message: "Failed to verify code" 
    });
  }
});

app.post("/api/auth/reset-password", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, code, newPassword } = req.body;
    
    console.log('🔐 Password reset attempt for email:', email);
    
    if (!email || !code || !newPassword) {
      res.status(400).json({ 
        message: "Email, verification code, and new password are required" 
      });
      return;
    }

    // Validate password
    if (newPassword.length < 6) {
      res.status(400).json({ 
        message: "Password must be at least 6 characters long" 
      });
      return;
    }

    // Find user by email
    const user = await storage.getUserByEmail(email);
    
    if (!user) {
      res.status(400).json({ 
        message: "Invalid email or verification code" 
      });
      return;
    }

    // Hash the provided code
    const hashedCode = crypto.createHash('sha256').update(code).digest('hex');
    
    // Find valid and verified reset token
    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          eq(passwordResetTokens.token, hashedCode),
          eq(passwordResetTokens.used, false),
          gt(passwordResetTokens.expiresAt, new Date())
        )
      )
      .limit(1);
    
    if (!resetToken) {
      res.status(400).json({ 
        message: "Invalid or expired verification code. Please request a new one." 
      });
      return;
    }

    // Check if code was verified
    const metadata = resetToken.metadata as any;
    if (!metadata?.verified) {
      res.status(400).json({ 
        message: "Code must be verified first" 
      });
      return;
    }

    // Check if code was recently verified (within 5 minutes)
    const verifiedAt = new Date(metadata.verifiedAt);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    if (verifiedAt < fiveMinutesAgo) {
      res.status(400).json({ 
        message: "Verification has expired. Please request a new code." 
      });
      return;
    }

    // Hash the new password
    const hashedPassword = await authService.hashPassword(newPassword);
    
    // Update user's password
    const updatedUser = await authService.updateUserPassword(user.id, hashedPassword);
    
    if (!updatedUser) {
      res.status(500).json({ 
        message: "Failed to reset password" 
      });
      return;
    }

    // Mark the token as used
    await db
      .update(passwordResetTokens)
      .set({ 
        used: true,
        usedAt: new Date(),
        metadata: {
          ...metadata,
          completedAt: new Date().toISOString()
        }
      })
      .where(eq(passwordResetTokens.id, resetToken.id));
    
    // Mark all other tokens for this user as used
    await db
      .update(passwordResetTokens)
      .set({ 
        used: true,
        usedAt: new Date()
      })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          eq(passwordResetTokens.used, false)
        )
      );
    
    // Log the successful reset
    await storage.createActivityLog({
      userId: user.id,
      type: "password_reset_completed",
      description: "Password successfully reset",
      metadata: { 
        email: user.email,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip || 'unknown'
      }
    });

    await storage.createSecurityAudit({
      userId: user.id,
      action: "password_reset",
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      success: true,
      metadata: {
        email: user.email,
        timestamp: new Date().toISOString()
      }
    });

    console.log(`✅ Password reset successfully for user: ${user.email}`);
    
    res.json({
      success: true,
      message: "Password has been reset successfully. You can now login with your new password."
    });

  } catch (error) {
    console.error("Password reset error:", error);
    
    // Log failed attempt if we have user context
    try {
      const { email } = req.body;
      if (email) {
        const user = await storage.getUserByEmail(email);
        
        if (user) {
          await storage.createSecurityAudit({
            userId: user.id,
            action: "password_reset_failed",
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            success: false,
            metadata: {
              error: error instanceof Error ? error.message : 'Unknown error',
              email: user.email,
              timestamp: new Date().toISOString()
            }
          });
        }
      }
    } catch (logError) {
      console.error("Failed to log security audit:", logError);
    }
    
    res.status(500).json({ 
      message: "Failed to reset password. Please try again." 
    });
  }
});

app.post("/api/auth/resend-code", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    
    console.log('🔄 Resending verification code for email:', email);
    
    if (!email) {
      res.status(400).json({ 
        message: "Email address is required" 
      });
      return;
    }

    // Find user by email
    const user = await storage.getUserByEmail(email);
    
    // Always return success to prevent email enumeration
    if (!user) {
      res.json({
        success: true,
        message: "If an account exists with that email, a new verification code has been sent."
      });
      return;
    }

    // Check for rate limiting - count recent tokens
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentTokens = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          gt(passwordResetTokens.createdAt, oneHourAgo)
        )
      );
    
    if (recentTokens.length >= 3) {
      res.status(429).json({ 
        message: "Too many requests. Please try again later." 
      });
      return;
    }

    // Mark existing unused tokens as used
    await db
      .update(passwordResetTokens)
      .set({ 
        used: true,
        usedAt: new Date(),
        metadata: sql`jsonb_set(COALESCE(metadata, '{}'), '{invalidatedReason}', '"new_code_requested"')`
      })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          eq(passwordResetTokens.used, false)
        )
      );

    // Generate new 6-digit verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedCode = crypto.createHash('sha256').update(verificationCode).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store new reset token
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      email: user.email,
      token: hashedCode,
      expiresAt,
      used: false,
      metadata: {
        type: 'verification_code',
        attempts: 0,
        verified: false,
        codeLength: 6,
        resent: true
      }
    });

    // SEND EMAIL WITH NEW VERIFICATION CODE
    try {
      const emailSent = await emailService.sendPasswordResetCode(user.email, verificationCode);
      
      if (emailSent) {
        console.log('✅ New verification code email sent to:', user.email);
      } else {
        console.warn('⚠️ Failed to send resend email');
      }
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
      // Continue anyway - in development, user can see code in response
    }

    // Log the activity
    await storage.createActivityLog({
      userId: user.id,
      type: "password_reset_code_resent",
      description: "Password reset code resent",
      metadata: { 
        email: user.email,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip || 'unknown'
      }
    });

    console.log('📧 New verification code generated for:', user.email);
    console.log('🔐 Code (for testing only):', verificationCode);

    res.json({
      success: true,
      message: "If an account exists with that email, a new verification code has been sent.",
      ...(process.env.NODE_ENV === 'development' && { 
        verificationCode,
        expiresAt: expiresAt.toISOString()
      })
    });

  } catch (error) {
    console.error("Resend code error:", error);
    res.status(500).json({ 
      message: "An error occurred. Please try again later." 
    });
  }
});



  // ===========================================================================
  // USER SETTINGS ROUTES
  // ===========================================================================
  
  app.get("/api/user/settings", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      console.log(`⚙️ Fetching settings for user: ${userId}`);
      
      const settings = await storage.getOrCreateUserSettings(userId);
      
      const transformedSettings = {
        profile: {
          name: settings.profileName || req.user!.name || "",
          email: settings.profileEmail || req.user!.email || "",
          company: settings.profileCompany || "",
          timezone: settings.profileTimezone || "America/New_York",
        },
        notifications: {
          emailReports: settings.notificationEmailReports,
          contentGenerated: settings.notificationContentGenerated,
          seoIssues: settings.notificationSeoIssues,
          systemAlerts: settings.notificationSystemAlerts,
        },
        automation: {
          defaultAiModel: settings.automationDefaultAiModel,
          autoFixSeoIssues: settings.automationAutoFixSeoIssues,
          contentGenerationFrequency: settings.automationContentGenerationFrequency,
          reportGeneration: settings.automationReportGeneration,
        },
        security: {
          twoFactorAuth: settings.securityTwoFactorAuth,
          sessionTimeout: settings.securitySessionTimeout,
          allowApiAccess: settings.securityAllowApiAccess,
        },
      };
      
      console.log(`✅ Settings fetched successfully for user ${userId}`);
      res.json(transformedSettings);
    } catch (error) {
      console.error("Failed to fetch user settings:", error);
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  app.put("/api/user/settings", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const { profile, notifications, automation, security } = req.body;
      
      console.log(`⚙️ Updating settings for user: ${userId}`);
      
      const updateData: Partial<InsertUserSettings> = {};
      
      if (profile) {
        if (profile.name !== undefined) updateData.profileName = profile.name;
        if (profile.email !== undefined) updateData.profileEmail = profile.email;
        if (profile.company !== undefined) updateData.profileCompany = profile.company;
        if (profile.timezone !== undefined) updateData.profileTimezone = profile.timezone;
      }
      
      if (notifications) {
        if (notifications.emailReports !== undefined) updateData.notificationEmailReports = notifications.emailReports;
        if (notifications.contentGenerated !== undefined) updateData.notificationContentGenerated = notifications.contentGenerated;
        if (notifications.seoIssues !== undefined) updateData.notificationSeoIssues = notifications.seoIssues;
        if (notifications.systemAlerts !== undefined) updateData.notificationSystemAlerts = notifications.systemAlerts;
      }
      
      if (automation) {
        if (automation.defaultAiModel !== undefined) updateData.automationDefaultAiModel = automation.defaultAiModel;
        if (automation.autoFixSeoIssues !== undefined) updateData.automationAutoFixSeoIssues = automation.autoFixSeoIssues;
        if (automation.contentGenerationFrequency !== undefined) updateData.automationContentGenerationFrequency = automation.contentGenerationFrequency;
        if (automation.reportGeneration !== undefined) updateData.automationReportGeneration = automation.reportGeneration;
      }
      
      if (security) {
        if (security.twoFactorAuth !== undefined) updateData.securityTwoFactorAuth = security.twoFactorAuth;
        if (security.sessionTimeout !== undefined) updateData.securitySessionTimeout = security.sessionTimeout;
        if (security.allowApiAccess !== undefined) updateData.securityAllowApiAccess = security.allowApiAccess;
      }
      
      if (updateData.securitySessionTimeout !== undefined) {
        if (updateData.securitySessionTimeout < 1 || updateData.securitySessionTimeout > 168) {
          res.status(400).json({ message: "Session timeout must be between 1 and 168 hours" });
          return;
        }
      }
      
      const updatedSettings = await storage.updateUserSettings(userId, updateData);
      
      if (!updatedSettings) {
        res.status(404).json({ message: "Settings not found" });
        return;
      }
      
      const transformedSettings = {
        profile: {
          name: updatedSettings.profileName || req.user!.name || "",
          email: updatedSettings.profileEmail || req.user!.email || "",
          company: updatedSettings.profileCompany || "",
          timezone: updatedSettings.profileTimezone || "America/New_York",
        },
        notifications: {
          emailReports: updatedSettings.notificationEmailReports,
          contentGenerated: updatedSettings.notificationContentGenerated,
          seoIssues: updatedSettings.notificationSeoIssues,
          systemAlerts: updatedSettings.notificationSystemAlerts,
        },
        automation: {
          defaultAiModel: updatedSettings.automationDefaultAiModel,
          autoFixSeoIssues: updatedSettings.automationAutoFixSeoIssues,
          contentGenerationFrequency: updatedSettings.automationContentGenerationFrequency,
          reportGeneration: updatedSettings.automationReportGeneration,
        },
        security: {
          twoFactorAuth: updatedSettings.securityTwoFactorAuth,
          sessionTimeout: updatedSettings.securitySessionTimeout,
          allowApiAccess: updatedSettings.securityAllowApiAccess,
        },
      };
      
      await storage.createActivityLog({
        userId,
        type: "settings_updated",
        description: "User settings updated",
        metadata: { 
          sectionsUpdated: Object.keys(req.body),
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`✅ Settings updated successfully for user ${userId}`);
      res.json(transformedSettings);
    } catch (error) {
      console.error("Failed to update user settings:", error);
      res.status(500).json({ message: "Failed to update settings" });
    }
  });

  app.delete("/api/user/settings", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      console.log(`🗑️ Resetting settings to defaults for user: ${userId}`);
      
      const deleted = await storage.deleteUserSettings(userId);
      
      if (!deleted) {
        res.status(404).json({ message: "Settings not found" });
        return;
      }
      
      const defaultSettings = await storage.getOrCreateUserSettings(userId);
      
      const transformedSettings = {
        profile: {
          name: req.user!.name || "",
          email: req.user!.email || "",
          company: "",
          timezone: "America/New_York",
        },
        notifications: {
          emailReports: true,
          contentGenerated: true,
          seoIssues: true,
          systemAlerts: false,
        },
        automation: {
          defaultAiModel: "gpt-4o",
          autoFixSeoIssues: true,
          contentGenerationFrequency: "twice-weekly",
          reportGeneration: "weekly",
        },
        security: {
          twoFactorAuth: false,
          sessionTimeout: 24,
          allowApiAccess: true,
        },
      };
      
      await storage.createActivityLog({
        userId,
        type: "settings_reset",
        description: "User settings reset to defaults",
        metadata: { 
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`✅ Settings reset to defaults for user ${userId}`);
      res.json({
        message: "Settings reset to defaults",
        settings: transformedSettings
      });
    } catch (error) {
      console.error("Failed to reset user settings:", error);
      res.status(500).json({ message: "Failed to reset settings" });
    }
  });


  //============================================================================
  //ADMIN ROUTES
  //============================================================================
  app.get("/api/admin/users", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    // Simple query without select object
    const allUsers = await db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt));

    res.json(allUsers);
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// Get system statistics (admin only)  
app.get("/api/admin/statistics", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const [userCount] = await db.select({ count: count() }).from(users);
    const [websiteCount] = await db.select({ count: count() }).from(websites);
    const [contentCount] = await db.select({ count: count() }).from(content);
    const [reportCount] = await db.select({ count: count() }).from(seoReports);
    
    // Get recent activity - fixed with correct table name
    const recentActivity = await db
      .select()
      .from(activityLogs)
      .orderBy(desc(activityLogs.createdAt))
      .limit(10);

    res.json({
      users: userCount.count || 0,
      websites: websiteCount.count || 0,
      content: contentCount.count || 0,
      reports: reportCount.count || 0,
      recentActivity
    });
  } catch (error) {
    console.error("Failed to fetch statistics:", error);
    res.status(500).json({ message: "Failed to fetch statistics" });
  }
});

// Update user admin status
app.put("/api/admin/users/:userId/admin-status", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { isAdmin } = req.body;
    
    // Prevent admin from removing their own admin status
    if (userId === req.user!.id && !isAdmin) {
      res.status(400).json({ message: "Cannot remove your own admin status" });
      return;
    }

    const [updatedUser] = await db
      .update(users)
      .set({ isAdmin, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updatedUser) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    await storage.createActivityLog({
      userId: req.user!.id,
      type: "admin_status_changed",
      description: `Admin status ${isAdmin ? 'granted to' : 'removed from'} user ${updatedUser.username}`,
      metadata: { targetUserId: userId, isAdmin }
    });

    res.json({
      id: updatedUser.id,
      username: updatedUser.username,
      email: updatedUser.email,
      isAdmin: updatedUser.isAdmin
    });
  } catch (error) {
    console.error("Failed to update admin status:", error);
    res.status(500).json({ message: "Failed to update admin status" });
  }
});

// Delete user (admin only)
app.delete("/api/admin/users/:userId", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    
    // Prevent self-deletion
    if (userId === req.user!.id) {
      res.status(400).json({ message: "Cannot delete your own account" });
      return;
    }

    const user = await storage.getUser(userId);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Delete user and cascade to related data
    await db.delete(users).where(eq(users.id, userId));

    await storage.createActivityLog({
      userId: req.user!.id,
      type: "user_deleted",
      description: `User ${user.username} deleted by admin`,
      metadata: { deletedUserId: userId, deletedUsername: user.username }
    });

    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete user:", error);
    res.status(500).json({ message: "Failed to delete user" });
  }
});


// Get specific user's API usage details (admin only)
app.get("/api/admin/users/:userId/api-usage", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    
    // Get user info
    const [userInfo] = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!userInfo) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Get overall usage summary for this user
    const [summary] = await db
      .select({
        totalRequests: sql<number>`COUNT(*)::integer`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        totalCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        userKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        systemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        userKeyTokens: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.tokensUsed} ELSE 0 END), 0)::integer`,
        systemKeyTokens: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.tokensUsed} ELSE 0 END), 0)::integer`,
        userKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        systemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .where(eq(aiUsageTracking.userId, userId));

    // Get usage by model and key type
    const modelUsage = await db
      .select({
        model: aiUsageTracking.model,
        keySource: aiUsageTracking.keyType,
        requests: sql<number>`COUNT(*)::integer`,
        tokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        costCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
      })
      .from(aiUsageTracking)
      .where(eq(aiUsageTracking.userId, userId))
      .groupBy(aiUsageTracking.model, aiUsageTracking.keyType)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Get usage by operation and key type
    const operationUsage = await db
      .select({
        operation: aiUsageTracking.operation,
        keySource: aiUsageTracking.keyType,
        requests: sql<number>`COUNT(*)::integer`,
        tokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        costCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
      })
      .from(aiUsageTracking)
      .where(eq(aiUsageTracking.userId, userId))
      .groupBy(aiUsageTracking.operation, aiUsageTracking.keyType)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Get daily usage for the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyUsage = await db
      .select({
        date: sql<string>`DATE(${aiUsageTracking.createdAt})`,
        requests: sql<number>`COUNT(*)::integer`,
        tokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        costCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        userKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        systemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
      })
      .from(aiUsageTracking)
      .where(
        and(
          eq(aiUsageTracking.userId, userId),
          gte(aiUsageTracking.createdAt, thirtyDaysAgo)
        )
      )
      .groupBy(sql`DATE(${aiUsageTracking.createdAt})`)
      .orderBy(desc(sql`DATE(${aiUsageTracking.createdAt})`));

    // Get monthly usage
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [monthlyUsage] = await db
      .select({
        monthlyRequests: sql<number>`COUNT(*)::integer`,
        monthlyTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        monthlyCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        monthlyUserKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        monthlySystemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        monthlyUserKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        monthlySystemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .where(
        and(
          eq(aiUsageTracking.userId, userId),
          gte(aiUsageTracking.createdAt, startOfMonth)
        )
      );

    // Format the response to match what the frontend expects
    const response = {
      user: userInfo,
      summary: summary || {
        totalRequests: 0,
        totalTokens: 0,
        totalCostCents: 0,
        userKeyRequests: 0,
        systemKeyRequests: 0,
        userKeyTokens: 0,
        systemKeyTokens: 0,
        userKeyCostCents: 0,
        systemKeyCostCents: 0,
      },
      modelUsage: modelUsage.map(item => ({
        model: item.model,
        keySource: item.keySource, // 'user' or 'system'
        requests: item.requests,
        tokens: item.tokens,
        costCents: item.costCents,
      })),
      operationUsage: operationUsage.map(item => ({
        operation: item.operation,
        keySource: item.keySource, // 'user' or 'system'
        requests: item.requests,
        tokens: item.tokens,
        costCents: item.costCents,
      })),
      dailyUsage,
      monthlyUsage: monthlyUsage || {
        monthlyRequests: 0,
        monthlyTokens: 0,
        monthlyCostCents: 0,
        monthlyUserKeyRequests: 0,
        monthlySystemKeyRequests: 0,
        monthlyUserKeyCostCents: 0,
        monthlySystemKeyCostCents: 0,
      },
      billingPeriod: {
        start: startOfMonth.toISOString(),
        end: new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0).toISOString()
      }
    };

    res.json(response);
  } catch (error) {
    console.error("Failed to fetch user API usage details:", error);
    res.status(500).json({ message: "Failed to fetch user API usage details" });
  }
});

// Get per-user API usage (admin only)
app.get("/api/admin/users-api-usage", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    // Get usage grouped by user with key type breakdown
    const userUsage = await db
      .select({
        userId: aiUsageTracking.userId,
        username: users.username,
        email: users.email,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        totalCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        requestCount: sql<number>`COUNT(*)::integer`,
        lastUsed: sql<Date>`MAX(${aiUsageTracking.createdAt})`,
        // Add key type breakdowns
        userKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        systemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        userKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        systemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        userKeyTokens: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.tokensUsed} ELSE 0 END), 0)::integer`,
        systemKeyTokens: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.tokensUsed} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .innerJoin(users, eq(aiUsageTracking.userId, users.id))
      .groupBy(aiUsageTracking.userId, users.username, users.email)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Get current month usage per user with key type breakdown
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlyUserUsage = await db
      .select({
        userId: aiUsageTracking.userId,
        username: users.username,
        monthlyTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        monthlyCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        monthlyRequests: sql<number>`COUNT(*)::integer`,
        // Add monthly key type breakdowns
        monthlyUserKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        monthlySystemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        monthlyUserKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        monthlySystemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .innerJoin(users, eq(aiUsageTracking.userId, users.id))
      .where(gte(aiUsageTracking.createdAt, startOfMonth))
      .groupBy(aiUsageTracking.userId, users.username)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Calculate totals for system vs user keys
    const systemKeyTotalRequests = userUsage.reduce((sum, user) => sum + (user.systemKeyRequests || 0), 0);
    const userKeyTotalRequests = userUsage.reduce((sum, user) => sum + (user.userKeyRequests || 0), 0);
    const systemKeyTotalCost = userUsage.reduce((sum, user) => sum + (user.systemKeyCostCents || 0), 0);
    const userKeyTotalCost = userUsage.reduce((sum, user) => sum + (user.userKeyCostCents || 0), 0);

    res.json({
      userUsage,
      monthlyUserUsage,
      totalUsers: userUsage.length,
      // Add summary totals
      systemKeyTotalRequests,
      userKeyTotalRequests,
      systemKeyTotalCost,
      userKeyTotalCost,
      billingPeriod: {
        start: startOfMonth.toISOString(),
        end: new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0).toISOString()
      }
    });
  } catch (error) {
    console.error("Failed to fetch per-user API usage:", error);
    res.status(500).json({ message: "Failed to fetch per-user API usage" });
  }
});

// Get specific user's API usage details (admin only)
// Get per-user API usage (admin only)
app.get("/api/admin/users-api-usage", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    // Get usage grouped by user with key type breakdown
    const userUsage = await db
      .select({
        userId: aiUsageTracking.userId,
        username: users.username,
        email: users.email,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        totalCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        requestCount: sql<number>`COUNT(*)::integer`,
        lastUsed: sql<Date>`MAX(${aiUsageTracking.createdAt})`,
        // Add key type breakdowns
        userKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        systemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        userKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        systemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        userKeyTokens: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.tokensUsed} ELSE 0 END), 0)::integer`,
        systemKeyTokens: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.tokensUsed} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .innerJoin(users, eq(aiUsageTracking.userId, users.id))
      .groupBy(aiUsageTracking.userId, users.username, users.email)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Get current month usage per user with key type breakdown
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlyUserUsage = await db
      .select({
        userId: aiUsageTracking.userId,
        username: users.username,
        monthlyTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        monthlyCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        monthlyRequests: sql<number>`COUNT(*)::integer`,
        // Add monthly key type breakdowns
        monthlyUserKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        monthlySystemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        monthlyUserKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        monthlySystemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .innerJoin(users, eq(aiUsageTracking.userId, users.id))
      .where(gte(aiUsageTracking.createdAt, startOfMonth))
      .groupBy(aiUsageTracking.userId, users.username)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Calculate totals for system vs user keys
    const systemKeyTotalRequests = userUsage.reduce((sum, user) => sum + (user.systemKeyRequests || 0), 0);
    const userKeyTotalRequests = userUsage.reduce((sum, user) => sum + (user.userKeyRequests || 0), 0);
    const systemKeyTotalCost = userUsage.reduce((sum, user) => sum + (user.systemKeyCostCents || 0), 0);
    const userKeyTotalCost = userUsage.reduce((sum, user) => sum + (user.userKeyCostCents || 0), 0);

    res.json({
      userUsage,
      monthlyUserUsage,
      totalUsers: userUsage.length,
      // Add summary totals
      systemKeyTotalRequests,
      userKeyTotalRequests,
      systemKeyTotalCost,
      userKeyTotalCost,
      billingPeriod: {
        start: startOfMonth.toISOString(),
        end: new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0).toISOString()
      }
    });
  } catch (error) {
    console.error("Failed to fetch per-user API usage:", error);
    res.status(500).json({ message: "Failed to fetch per-user API usage" });
  }
});

// Update system API usage endpoint to also differentiate by key type
app.get("/api/admin/system-api-usage", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    // Get all AI usage tracking grouped by provider and key type
    const systemUsage = await db
      .select({
        model: aiUsageTracking.model,
        operation: aiUsageTracking.operation,
        keyType: aiUsageTracking.keyType,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        totalCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        usageCount: sql<number>`COUNT(*)::integer`,
        lastUsed: sql<Date>`MAX(${aiUsageTracking.createdAt})`,
      })
      .from(aiUsageTracking)
      .groupBy(aiUsageTracking.model, aiUsageTracking.operation, aiUsageTracking.keyType)
      .orderBy(desc(sql`SUM(${aiUsageTracking.costUsd})`));

    // Get usage by time period (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyUsage = await db
      .select({
        date: sql<string>`DATE(${aiUsageTracking.createdAt})`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        totalCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        requests: sql<number>`COUNT(*)::integer`,
        systemRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        userRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
      })
      .from(aiUsageTracking)
      .where(gte(aiUsageTracking.createdAt, thirtyDaysAgo))
      .groupBy(sql`DATE(${aiUsageTracking.createdAt})`)
      .orderBy(desc(sql`DATE(${aiUsageTracking.createdAt})`));

    // Get current month usage with key type breakdown
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [monthlyStats] = await db
      .select({
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageTracking.tokensUsed}), 0)::integer`,
        totalCostCents: sql<number>`COALESCE(SUM(${aiUsageTracking.costUsd}), 0)::integer`,
        totalRequests: sql<number>`COUNT(*)::integer`,
        systemKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN 1 END)::integer`,
        userKeyRequests: sql<number>`COUNT(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN 1 END)::integer`,
        systemKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'system' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
        userKeyCostCents: sql<number>`COALESCE(SUM(CASE WHEN ${aiUsageTracking.keyType} = 'user' THEN ${aiUsageTracking.costUsd} ELSE 0 END), 0)::integer`,
      })
      .from(aiUsageTracking)
      .where(gte(aiUsageTracking.createdAt, startOfMonth));

    // Check which system keys are configured
    const systemKeysStatus = {
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      google: !!process.env.GOOGLE_AI_API_KEY,
      googlePageSpeed: !!process.env.GOOGLE_PAGESPEED_API_KEY,
      cloudinary: !!process.env.CLOUDINARY_API_KEY,
    };

    // Calculate estimated costs per provider with key type
    const providerCosts = systemUsage.reduce((acc: any, usage: any) => {
      const provider = usage.model.includes('gpt') ? 'openai' : 
                      usage.model.includes('claude') ? 'anthropic' : 
                      usage.model.includes('gemini') ? 'google' : 'other';
      
      if (!acc[provider]) {
        acc[provider] = { 
          tokens: 0, 
          costCents: 0, 
          requests: 0,
          systemKeyTokens: 0,
          userKeyTokens: 0,
          systemKeyCostCents: 0,
          userKeyCostCents: 0,
          systemKeyRequests: 0,
          userKeyRequests: 0
        };
      }
      
      acc[provider].tokens += usage.totalTokens;
      acc[provider].costCents += usage.totalCostCents;
      acc[provider].requests += usage.usageCount;
      
      if (usage.keyType === 'system') {
        acc[provider].systemKeyTokens += usage.totalTokens;
        acc[provider].systemKeyCostCents += usage.totalCostCents;
        acc[provider].systemKeyRequests += usage.usageCount;
      } else {
        acc[provider].userKeyTokens += usage.totalTokens;
        acc[provider].userKeyCostCents += usage.totalCostCents;
        acc[provider].userKeyRequests += usage.usageCount;
      }
      
      return acc;
    }, {});

    res.json({
      systemKeysStatus,
      usageByModel: systemUsage,
      dailyUsage,
      monthlyStats: monthlyStats || { 
        totalTokens: 0, 
        totalCostCents: 0, 
        totalRequests: 0,
        systemKeyRequests: 0,
        userKeyRequests: 0,
        systemKeyCostCents: 0,
        userKeyCostCents: 0
      },
      providerCosts,
      currentDate: new Date().toISOString(),
      billingPeriod: {
        start: startOfMonth.toISOString(),
        end: new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0).toISOString()
      }
    });
  } catch (error) {
    console.error("Failed to fetch system API usage:", error);
    res.status(500).json({ message: "Failed to fetch system API usage" });
  }
});

  // ===========================================================================
  // API KEY MANAGEMENT ROUTES
  // ===========================================================================
  
  app.get("/api/user/api-keys", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      console.log(`🔑 Fetching API keys for user: ${userId}`);
      
      const apiKeys = await storage.getUserApiKeys(userId);
      
      const transformedKeys = apiKeys.map(key => ({
        id: key.id,
        provider: key.provider,
        keyName: key.keyName,
        maskedKey: key.maskedKey,
        isActive: key.isActive,
        validationStatus: key.validationStatus,
        lastValidated: key.lastValidated?.toISOString(),
        validationError: key.validationError,
        usageCount: key.usageCount,
        lastUsed: key.lastUsed?.toISOString(),
        createdAt: key.createdAt.toISOString()
      }));
      
      console.log(`✅ Found ${transformedKeys.length} API keys for user ${userId}`);
      res.json(transformedKeys);
    } catch (error) {
      console.error("Failed to fetch API keys:", error);
      res.status(500).json({ message: "Failed to fetch API keys" });
    }
  });

  app.post("/api/user/api-keys", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const { provider, keyName, apiKey } = req.body;
      
      console.log(`🔑 Adding API key for user: ${userId}, provider: ${provider}`);
      
      if (!provider || !keyName || !apiKey) {
        res.status(400).json({ message: "Provider, key name, and API key are required" });
        return;
      }
      
      if (!apiValidationService.getSupportedProviders().includes(provider)) {
        res.status(400).json({ message: "Invalid provider" });
        return;
      }
      
      const existingKeys = await storage.getUserApiKeys(userId);
      const existingProviderKey = existingKeys.find(k => k.provider === provider && k.isActive);
      
      if (existingProviderKey) {
        res.status(400).json({ 
          message: `You already have an active ${apiValidationService.getProviderDisplayName(provider)} API key. Please delete the existing one first.` 
        });
        return;
      }
      
      let newApiKey;
      try {
        newApiKey = await storage.createUserApiKey(userId, {
          provider,
          keyName,
          apiKey
        });
      } catch (createError) {
        res.status(400).json({ 
          message: createError instanceof Error ? createError.message : "Invalid API key format"
        });
        return;
      }
      
      console.log(`🔍 Validating ${provider} API key...`);
      
      let validationResult;
      try {
        validationResult = await apiValidationService.validateApiKey(provider, apiKey);
      } catch (validationError) {
        console.error(`Validation failed for ${provider}:`, validationError);
        validationResult = { 
          valid: false, 
          error: validationError instanceof Error ? validationError.message : 'Validation failed' 
        };
      }
      
      await storage.updateUserApiKey(userId, newApiKey.id, {
        validationStatus: validationResult.valid ? 'valid' : 'invalid',
        lastValidated: new Date(),
        validationError: validationResult.error || null
      });
      
      const updatedKey = await storage.getUserApiKey(userId, newApiKey.id);
      
      if (!validationResult.valid) {
        await storage.deleteUserApiKey(userId, newApiKey.id);
        
        res.status(400).json({ 
          message: validationResult.error || "API key validation failed",
          error: "INVALID_API_KEY"
        });
        return;
      }
      
      // CLEAR CACHE after successfully adding key
      if (provider === 'openai') {
        console.log('🔄 Clearing OpenAI cache for AI and image services');
        aiService.clearApiKeyCache(userId, 'openai');
        imageService.clearApiKeyCache(userId);
      } else if (provider === 'anthropic') {
        console.log('🔄 Clearing Anthropic cache for AI service');
        aiService.clearApiKeyCache(userId, 'anthropic');
      } else if (provider === 'google_pagespeed' || provider === 'gemini') {
        console.log('🔄 Clearing Gemini cache for AI service');
        aiService.clearApiKeyCache(userId, 'gemini');
      }
      
      await storage.createActivityLog({
        userId,
        type: "api_key_added",
        description: `API key added for ${apiValidationService.getProviderDisplayName(provider)}: ${keyName}`,
        metadata: { 
          provider,
          keyName,
          keyId: newApiKey.id,
          validationStatus: validationResult.valid ? 'valid' : 'invalid'
        }
      });
      
      console.log(`✅ API key added and validated successfully for user ${userId}`);
      
      res.status(201).json({
        id: updatedKey!.id,
        provider: updatedKey!.provider,
        keyName: updatedKey!.keyName,
        maskedKey: updatedKey!.maskedKey,
        isActive: updatedKey!.isActive,
        validationStatus: updatedKey!.validationStatus,
        lastValidated: updatedKey!.lastValidated?.toISOString(),
        validationError: updatedKey!.validationError,
        usageCount: updatedKey!.usageCount,
        lastUsed: updatedKey!.lastUsed?.toISOString(),
        createdAt: updatedKey!.createdAt.toISOString()
      });
    } catch (error) {
      console.error("Failed to add API key:", error);
      res.status(500).json({ 
        message: "Failed to add API key",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post("/api/user/api-keys/:id/validate", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const keyId = req.params.id;
      
      console.log(`🔍 Validating API key ${keyId} for user: ${userId}`);
      
      const apiKey = await storage.getUserApiKey(userId, keyId);
      if (!apiKey) {
        res.status(404).json({ message: "API key not found" });
        return;
      }
      
      const decryptedKey = await storage.getDecryptedApiKey(userId, keyId);
      if (!decryptedKey) {
        res.status(400).json({ message: "Cannot decrypt API key" });
        return;
      }
      
      let validationResult;
      try {
        validationResult = await apiValidationService.validateApiKey(apiKey.provider, decryptedKey);
      } catch (validationError) {
        console.error(`Validation failed for ${apiKey.provider}:`, validationError);
        validationResult = { 
          valid: false, 
          error: validationError instanceof Error ? validationError.message : 'Validation failed' 
        };
      }
      
      await storage.updateUserApiKey(userId, keyId, {
        validationStatus: validationResult.valid ? 'valid' : 'invalid',
        lastValidated: new Date(),
        validationError: validationResult.error || null
      });
      
      await storage.createActivityLog({
        userId,
        type: "api_key_validated",
        description: `API key validation ${validationResult.valid ? 'successful' : 'failed'}: ${apiKey.keyName}`,
        metadata: { 
          keyId,
          provider: apiKey.provider,
          isValid: validationResult.valid,
          error: validationResult.error
        }
      });
      
      console.log(`✅ API key validation completed for user ${userId}: ${validationResult.valid ? 'valid' : 'invalid'}`);
      
      res.json({
        isValid: validationResult.valid,
        error: validationResult.error,
        lastValidated: new Date().toISOString()
      });
    } catch (error) {
      console.error("Failed to validate API key:", error);
      res.status(500).json({ 
        message: "Failed to validate API key",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.delete("/api/user/api-keys/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const keyId = req.params.id;
      
      console.log(`🗑️ Deleting API key ${keyId} for user: ${userId}`);
      
      const apiKey = await storage.getUserApiKey(userId, keyId);
      if (!apiKey) {
        res.status(404).json({ message: "API key not found" });
        return;
      }
      
      const deleted = await storage.deleteUserApiKey(userId, keyId);
      
      if (!deleted) {
        res.status(404).json({ message: "API key not found" });
        return;
      }
      
      // CLEAR CACHE after successfully deleting key
      if (apiKey.provider === 'openai') {
        console.log('🔄 Clearing OpenAI cache after key deletion');
        aiService.clearApiKeyCache(userId, 'openai');
        imageService.clearApiKeyCache(userId);
      } else if (apiKey.provider === 'anthropic') {
        console.log('🔄 Clearing Anthropic cache after key deletion');
        aiService.clearApiKeyCache(userId, 'anthropic');
      } else if (apiKey.provider === 'google_pagespeed' || apiKey.provider === 'gemini') {
        console.log('🔄 Clearing Gemini cache after key deletion');
        aiService.clearApiKeyCache(userId, 'gemini');
      }
      
      await storage.createActivityLog({
        userId,
        type: "api_key_deleted",
        description: `API key deleted: ${apiKey.keyName} (${apiValidationService.getProviderDisplayName(apiKey.provider)})`,
        metadata: { 
          keyId,
          provider: apiKey.provider,
          keyName: apiKey.keyName
        }
      });
      
      console.log(`✅ API key deleted successfully for user ${userId}`);
      res.status(204).send();
    } catch (error) {
      console.error("Failed to delete API key:", error);
      res.status(500).json({ 
        message: "Failed to delete API key",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

app.get("/api/user/api-keys/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const userKeys = await storage.getUserApiKeys(userId);
    
    const providers: any = {
      openai: { configured: false, keyName: null, status: "not_configured", usage: null },
      anthropic: { configured: false, keyName: null, status: "not_configured", usage: null },
      google_pagespeed: { configured: false, keyName: null, status: "not_configured", usage: null }
    };
    
    // Check user keys
    for (const key of userKeys) {
      if (key.isActive && providers[key.provider as keyof typeof providers]) {
        const providerStatus = providers[key.provider as keyof typeof providers];
        
        try {
          const usageStats = await storage.getApiKeyUsageStats(userId, key.provider);
          
          providerStatus.configured = true;
          providerStatus.keyName = key.keyName;
          providerStatus.status = key.validationStatus === 'valid' ? 'active' : 'invalid';
          providerStatus.keyId = key.id;
          providerStatus.usage = {
            totalUsageCount: key.usageCount || 0,
            totalTokens: usageStats?.userKeyUsage?.tokens || 0,
            totalCostCents: usageStats?.userKeyUsage?.costCents || 0,
            lastUsed: key.lastUsed,
          };
          
          console.log(`Usage stats for ${key.provider}:`, {
            totalTokens: providerStatus.usage.totalTokens,
            totalCostCents: providerStatus.usage.totalCostCents,
            operationsCount: providerStatus.usage.totalUsageCount
          });
        } catch (statsError) {
          console.error(`Failed to get usage stats for ${key.provider}:`, statsError);
          // Still set the provider as configured, just with zero usage
          providerStatus.configured = true;
          providerStatus.keyName = key.keyName;
          providerStatus.status = key.validationStatus === 'valid' ? 'active' : 'invalid';
          providerStatus.keyId = key.id;
          providerStatus.usage = {
            totalUsageCount: key.usageCount || 0,
            totalTokens: 0,
            totalCostCents: 0,
            lastUsed: key.lastUsed,
          };
        }
      }
    }
    
    // Check system keys and add their usage
    for (const [provider, envVar] of Object.entries({
      openai: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR,
      anthropic: process.env.ANTHROPIC_API_KEY,
      google_pagespeed: process.env.GOOGLE_PAGESPEED_API_KEY
    })) {
      if (envVar && !providers[provider].configured) {
        try {
          const usageStats = await storage.getApiKeyUsageStats(userId, provider);
          
          providers[provider] = {
            configured: true,
            keyName: `System ${provider.replace('_', ' ')} Key`,
            status: "system",
            keyId: `system-${provider}`,
            usage: {
              totalUsageCount: usageStats?.systemKeyUsage?.operations || 0,
              totalTokens: usageStats?.systemKeyUsage?.tokens || 0,
              totalCostCents: usageStats?.systemKeyUsage?.costCents || 0,
              lastUsed: null,
            }
          };
          
          console.log(`Usage stats for ${provider}:`, {
            totalTokens: providers[provider].usage.totalTokens,
            totalCostCents: providers[provider].usage.totalCostCents,
            operationsCount: providers[provider].usage.totalUsageCount
          });
        } catch (statsError) {
          console.error(`Failed to get usage stats for system ${provider}:`, statsError);
          // Still mark as configured but with zero usage
          providers[provider] = {
            configured: true,
            keyName: `System ${provider.replace('_', ' ')} Key`,
            status: "system",
            keyId: `system-${provider}`,
            usage: {
              totalUsageCount: 0,
              totalTokens: 0,
              totalCostCents: 0,
              lastUsed: null,
            }
          };
        }
      }
    }
    
    res.json({ providers });
  } catch (error) {
    console.error("Failed to fetch API key status:", error);
    res.status(500).json({ message: "Failed to fetch API key status" });
  }
});

// Additional helper function to check if storage.getApiKeyUsageStats is returning the expected structure
// You might want to add this to your storage module if the issue persists
function ensureUsageStatsStructure(stats: any) {
  return {
    userKeyUsage: {
      tokens: stats?.userKeyUsage?.tokens || 0,
      costCents: stats?.userKeyUsage?.costCents || 0,
      operations: stats?.userKeyUsage?.operations || 0
    },
    systemKeyUsage: {
      tokens: stats?.systemKeyUsage?.tokens || 0,
      costCents: stats?.systemKeyUsage?.costCents || 0,
      operations: stats?.systemKeyUsage?.operations || 0
    }
  };
}

  app.put("/api/user/api-keys/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const keyId = req.params.id;
      const { isActive } = req.body;
      
      const apiKey = await storage.getUserApiKey(userId, keyId);
      if (!apiKey) {
        res.status(404).json({ message: "API key not found" });
        return;
      }
      
      await storage.updateUserApiKey(userId, keyId, {
        isActive: isActive !== undefined ? isActive : apiKey.isActive,
      });
      
      // CLEAR CACHE when key is deactivated/activated
      if (isActive !== undefined) {
        if (apiKey.provider === 'openai') {
          console.log('🔄 Clearing OpenAI cache after key status change');
          aiService.clearApiKeyCache(userId, 'openai');
          imageService.clearApiKeyCache(userId);
        } else if (apiKey.provider === 'anthropic') {
          console.log('🔄 Clearing Anthropic cache after key status change');
          aiService.clearApiKeyCache(userId, 'anthropic');
        } else if (apiKey.provider === 'google_pagespeed' || apiKey.provider === 'gemini') {
          console.log('🔄 Clearing Gemini cache after key status change');
          aiService.clearApiKeyCache(userId, 'gemini');
        }
      }
      
      const updatedKey = await storage.getUserApiKey(userId, keyId);
      res.json(updatedKey);
    } catch (error) {
      console.error("Failed to update API key:", error);
      res.status(500).json({ 
        message: "Failed to update API key",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });


 app.get("/api/user/api-keys/:id/usage", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const keyId = req.params.id;
    
    // Handle system keys differently
    if (keyId === 'system-openai' || keyId === 'system-anthropic' || keyId === 'system-google') {
      const provider = keyId.replace('system-', '').replace('-', '_');
      const usageStats = await storage.getApiKeyUsageStats(userId, provider);
      
      res.json({
        keyId: keyId,
        provider: provider,
        keyName: `System ${provider} Key`,
        totalUsageCount: usageStats.systemKeyUsage.operations,
        totalTokens: usageStats.systemKeyUsage.tokens,
        totalCostCents: usageStats.systemKeyUsage.costCents,
        keyType: 'system',
        lastUsed: null, // You might want to track this separately
      });
      return;
    }
    
    // Handle user keys
    const apiKey = await storage.getUserApiKey(userId, keyId);
    if (!apiKey) {
      res.status(404).json({ message: "API key not found" });
      return;
    }
    
    const usageStats = await storage.getApiKeyUsageStats(userId, apiKey.provider);
    
    res.json({
      keyId: apiKey.id,
      provider: apiKey.provider,
      keyName: apiKey.keyName,
      totalUsageCount: apiKey.usageCount || 0,
      totalTokens: usageStats.userKeyUsage.tokens,
      totalCostCents: usageStats.userKeyUsage.costCents,
      keyType: 'user',
      lastUsed: apiKey.lastUsed,
    });
  } catch (error) {
    console.error("Failed to fetch API key usage:", error);
    res.status(500).json({ message: "Failed to fetch usage statistics" });
  }
});


app.get("/api/user/api-keys/usage-summary", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    
    // Get user's configured keys
    const userKeys = await storage.getUserApiKeys(userId);
    
    // Get all usage data for the user (simpler query)
    const allUsageData = await db
      .select({
        model: aiUsageTracking.model,
        keyType: aiUsageTracking.keyType,
        tokensUsed: aiUsageTracking.tokensUsed,
        costUsd: aiUsageTracking.costUsd,
        operation: aiUsageTracking.operation,
        createdAt: aiUsageTracking.createdAt,
      })
      .from(aiUsageTracking)
      .where(eq(aiUsageTracking.userId, userId));

    // Process the data in JavaScript instead of complex SQL
    const aggregated: Record<string, Record<string, any>> = {};
    
    for (const row of allUsageData) {
      // Determine provider from model
      let provider = 'other';
      if (row.model.includes('gpt') || row.model === 'dall-e-3') {
        provider = 'openai';
      } else if (row.model.includes('claude')) {
        provider = 'anthropic';
      } else if (row.model.includes('gemini')) {
        provider = 'gemini';
      }
      
      // Create key for aggregation
      const key = `${provider}-${row.keyType}`;
      
      if (!aggregated[key]) {
        aggregated[key] = {
          provider,
          keyType: row.keyType,
          operations: 0,
          tokens: 0,
          costCents: 0,
          lastUsed: null,
          operationBreakdown: {}
        };
      }
      
      // Aggregate data
      aggregated[key].operations += 1;
      aggregated[key].tokens += row.tokensUsed || 0;
      aggregated[key].costCents += row.costUsd || 0;
      
      // Track latest usage
      if (!aggregated[key].lastUsed || new Date(row.createdAt) > new Date(aggregated[key].lastUsed)) {
        aggregated[key].lastUsed = row.createdAt;
      }
      
      // Track operation breakdown
      if (!aggregated[key].operationBreakdown[row.operation]) {
        aggregated[key].operationBreakdown[row.operation] = 0;
      }
      aggregated[key].operationBreakdown[row.operation] += 1;
    }

    // Structure the response
    const summary = {
      providers: {
        openai: {
          user: { operations: 0, tokens: 0, costCents: 0, lastUsed: null, breakdown: {} },
          system: { operations: 0, tokens: 0, costCents: 0, lastUsed: null, breakdown: {} },
          configured: false,
          userKeyName: null as string | null,
          userKeyStatus: null as string | null,
        },
        anthropic: {
          user: { operations: 0, tokens: 0, costCents: 0, lastUsed: null, breakdown: {} },
          system: { operations: 0, tokens: 0, costCents: 0, lastUsed: null, breakdown: {} },
          configured: false,
          userKeyName: null as string | null,
          userKeyStatus: null as string | null,
        },
        gemini: {
          user: { operations: 0, tokens: 0, costCents: 0, lastUsed: null, breakdown: {} },
          system: { operations: 0, tokens: 0, costCents: 0, lastUsed: null, breakdown: {} },
          configured: false,
          userKeyName: null as string | null,
          userKeyStatus: null as string | null,
        }
      },
      totals: {
        user: { operations: 0, tokens: 0, costCents: 0 },
        system: { operations: 0, tokens: 0, costCents: 0 },
        combined: { operations: 0, tokens: 0, costCents: 0 }
      }
    };

    // Fill in aggregated data
    for (const data of Object.values(aggregated)) {
      const provider = data.provider as keyof typeof summary.providers;
      const keyType = data.keyType as 'user' | 'system';
      
      if (summary.providers[provider]) {
        summary.providers[provider][keyType] = {
          operations: data.operations,
          tokens: data.tokens,
          costCents: data.costCents,
          lastUsed: data.lastUsed,
          breakdown: data.operationBreakdown
        };
        
        // Update totals
        summary.totals[keyType].operations += data.operations;
        summary.totals[keyType].tokens += data.tokens;
        summary.totals[keyType].costCents += data.costCents;
      }
    }

    // Calculate combined totals
    summary.totals.combined = {
      operations: summary.totals.user.operations + summary.totals.system.operations,
      tokens: summary.totals.user.tokens + summary.totals.system.tokens,
      costCents: summary.totals.user.costCents + summary.totals.system.costCents,
    };

    // Add configuration status for user keys
    for (const key of userKeys) {
      const providerMap: Record<string, keyof typeof summary.providers> = {
        'openai': 'openai',
        'anthropic': 'anthropic',
        'gemini': 'gemini',
        'google_gemini': 'gemini',
        'google_pagespeed': 'gemini' // If PageSpeed uses Gemini models
      };
      
      const mappedProvider = providerMap[key.provider];
      if (key.isActive && mappedProvider && summary.providers[mappedProvider]) {
        const provider = summary.providers[mappedProvider];
        provider.configured = true;
        provider.userKeyName = key.keyName;
        provider.userKeyStatus = key.validationStatus;
      }
    }

    // Check for system keys (only mark as configured if no user key exists)
    if (!summary.providers.openai.userKeyName && (process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR)) {
      summary.providers.openai.configured = true;
    }
    if (!summary.providers.anthropic.userKeyName && process.env.ANTHROPIC_API_KEY) {
      summary.providers.anthropic.configured = true;
    }
    if (!summary.providers.gemini.userKeyName && process.env.GOOGLE_GEMINI_API_KEY) {
      summary.providers.gemini.configured = true;
    }

    console.log(`✅ Usage summary fetched for user ${userId}:`, {
      totalOps: summary.totals.combined.operations,
      userOps: summary.totals.user.operations,
      systemOps: summary.totals.system.operations,
      rows: allUsageData.length
    });

    res.json(summary);
  } catch (error) {
    console.error("Failed to fetch usage summary:", error);
    res.status(500).json({ 
      message: "Failed to fetch usage summary",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});


  // ===========================================================================
  // WEBSITE MANAGEMENT ROUTES
  // ===========================================================================
  
  app.get("/api/user/websites", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      console.log(`🌐 Fetching websites for user: ${userId}`);
      
      const websites = await storage.getUserWebsites(userId);
      console.log(`✅ Found ${websites.length} websites for user ${userId}`);
      
      res.json(websites);
    } catch (error) {
      console.error("Failed to fetch user websites:", error);
      res.status(500).json({ message: "Failed to fetch websites" });
    }
  });

  app.get("/api/user/websites/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const website = await storage.getUserWebsite(req.params.id, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      res.json(website);
    } catch (error) {
      console.error("Failed to fetch user website:", error);
      res.status(500).json({ message: "Failed to fetch website" });
    }
  });

  app.post("/api/user/websites", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      console.log(`🌐 Creating website for user: ${userId}`, req.body);
      
      const validatedData = insertWebsiteSchema.parse(req.body);
      const websiteWithUserId = { ...validatedData, userId };
      
      const website = await storage.createWebsite(websiteWithUserId);
      console.log(`✅ Website created successfully:`, website.id);
      
      res.status(201).json(website);
    } catch (error) {
      console.error("Failed to create website:", error);
      
      if (error instanceof Error) {
        if (error.message.includes('authentication')) {
          res.status(401).json({ message: "WordPress authentication failed. Please check your credentials." });
          return;
        }
        if (error.message.includes('validation')) {
          res.status(400).json({ message: "Invalid website data: " + error.message });
          return;
        }
      }
      
      res.status(400).json({ message: "Failed to create website" });
    }
  });

  app.put("/api/user/websites/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const existingWebsite = await storage.getUserWebsite(req.params.id, userId);
      if (!existingWebsite) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      
      const website = await storage.updateWebsite(req.params.id, req.body);
      res.json(website);
    } catch (error) {
      console.error("Failed to update website:", error);
      res.status(500).json({ message: "Failed to update website" });
    }
  });

  app.delete("/api/user/websites/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const existingWebsite = await storage.getUserWebsite(req.params.id, userId);
      if (!existingWebsite) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      
      const deleted = await storage.deleteWebsite(req.params.id);
      if (!deleted) {
        res.status(404).json({ message: "Website not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error("Failed to delete website:", error);
      res.status(500).json({ message: "Failed to delete website" });
    }
  });

  app.post("/api/user/websites/:id/validate-ownership", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const website = await storage.getUserWebsite(req.params.id, userId);
      if (!website) {
        res.status(403).json({ message: "Website not found or access denied" });
        return;
      }
      res.json({ valid: true, websiteId: website.id, userId });
    } catch (error) {
      console.error("Website ownership validation failed:", error);
      res.status(500).json({ message: "Validation failed" });
    }
  });

  // ===========================================================================
  // CONTENT MANAGEMENT ROUTES
  // ===========================================================================
  
  app.get("/api/user/websites/:id/content", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const website = await storage.getUserWebsite(req.params.id, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      
      const content = await storage.getContentByWebsite(req.params.id);
      res.json(content);
    } catch (error) {
      console.error("Failed to fetch content:", error);
      res.status(500).json({ message: "Failed to fetch content" });
    }
  });



  app.get("/api/user/content/auto-generated", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId, scheduleId } = req.query;
    
    // Fetch all content
    let content;
    if (websiteId) {
      const website = await storage.getUserWebsite(websiteId as string, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found" });
        return;
      }
      content = await storage.getWebsiteContent(websiteId as string);
    } else {
      content = await storage.getUserContent(userId);
    }
    
    // Filter for auto-generated (has scheduleId)
    let autoContent = content.filter((item: any) => item.scheduleId);
    
    if (scheduleId) {
      autoContent = autoContent.filter((item: any) => item.scheduleId === scheduleId);
    }
    
    // Add schedule names
    const enhanced = await Promise.all(
      autoContent.map(async (item: any) => {
        const schedule = await storage.getAutoScheduleById(item.scheduleId);
        return {
          ...item,
          scheduleName: schedule?.name || 'Unknown',
          scheduleFrequency: schedule?.frequency,
        };
      })
    );
    
    enhanced.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    res.json(enhanced);
  } catch (error) {
    console.error("Failed to fetch auto-generated content:", error);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});


  // Get ALL content for user (including standalone content)
  // IMPORTANT: This route MUST come before /api/user/content/:id to avoid matching "all" as an ID
  app.get("/api/user/content/all", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      
      console.log(`📝 Fetching all content for user: ${userId}`);
      
      // Fetch all content - using actual schema fields
      const allContent = await db
        .select({
          id: content.id,
          userId: content.userId,
          websiteId: content.websiteId,
          niche: content.niche,
          title: content.title,
          body: content.body,
          excerpt: content.excerpt,
          metaDescription: content.metaDescription,
          metaTitle: content.metaTitle,
          status: content.status,
          approvedBy: content.approvedBy,
          approvedAt: content.approvedAt,
          rejectionReason: content.rejectionReason,
          aiModel: content.aiModel,
          seoKeywords: content.seoKeywords,
          seoScore: content.seoScore,
          readabilityScore: content.readabilityScore,
          plagiarismScore: content.plagiarismScore,
          brandVoiceScore: content.brandVoiceScore,
          factCheckStatus: content.factCheckStatus,
          eatCompliance: content.eatCompliance,
          tokensUsed: content.tokensUsed,
          costUsd: content.costUsd,
          publishDate: content.publishDate,
          wordpressPostId: content.wordpressPostId,
          wordpressUrl: content.wordpressUrl,
          publishError: content.publishError,
          images: content.images,
          cloudinaryData: content.cloudinaryData,
          featuredImageUrl: content.featuredImageUrl,
          featuredImageCloudinaryId: content.featuredImageCloudinaryId,
          hasImages: content.hasImages,
          imageCount: content.imageCount,
          imageCostCents: content.imageCostCents,
          totalImageCost: content.totalImageCost,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt,
        })
        .from(content)
        .where(eq(content.userId, userId))
        .orderBy(desc(content.createdAt));
      
      // Map fields for frontend compatibility
      const mappedContent = allContent.map(item => ({
        ...item,
        // Map aiModel to aiProvider for frontend
        aiProvider: item.aiModel?.includes('gpt') ? 'openai' : 
                    item.aiModel?.includes('claude') ? 'anthropic' :
                    item.aiModel?.includes('gemini') ? 'gemini' : 'openai',
        // Map publishDate to scheduledAt and publishedAt for frontend
        scheduledAt: item.publishDate,
        publishedAt: item.status === 'published' ? item.publishDate : null,
      }));
      
      console.log(`✅ Found ${allContent.length} content items (${allContent.filter(c => c.websiteId).length} website, ${allContent.filter(c => c.niche && !c.websiteId).length} standalone)`);
      
      res.json(mappedContent);
    } catch (error) {
      console.error("❌ Failed to fetch all user content:", error);
      res.status(500).json({ 
        message: "Failed to fetch content",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  app.get("/api/user/content/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const contentId = req.params.id;
      
      const content = await storage.getContent(contentId);
      if (!content || content.userId !== userId) {
        res.status(404).json({ message: "Content not found or access denied" });
        return;
      }

      res.json({
        ...content,
        content: content.body,
        wordCount: content.body ? content.body.split(/\s+/).length : 0,
        readingTime: content.body ? Math.ceil(content.body.split(/\s+/).length / 200) : 0,
      });
    } catch (error) {
      console.error("Failed to fetch content:", error);
      res.status(500).json({ message: "Failed to fetch content" });
    }
  });


  app.post("/api/user/content/generate", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId, niche, language = "english", ...contentData } = req.body;
    
    console.log('🔍 [Route Handler] Received prompt fields:', {
      promptType: contentData.promptType,
      hasCustomPrompt: !!contentData.customPrompt,
      customPromptLength: contentData.customPrompt?.length || 0
    });
    
    console.log('🔍 DEBUG: Raw request body:', {
      websiteId: websiteId || 'none',
      niche: niche || 'none',
      language: language || 'english',
      contentType: websiteId ? 'website' : 'standalone',
      contentData: {
        includeImages: contentData.includeImages,
        imageCount: contentData.imageCount,
        imageStyle: contentData.imageStyle,
        aiProvider: contentData.aiProvider,
        topic: contentData.topic
      }
    });

    // Validate EITHER websiteId OR niche (not both, not neither)
    if (!websiteId && !niche) {
      res.status(400).json({ 
        message: "Either websiteId or niche must be provided for content generation" 
      });
      return;
    }
    if (websiteId && niche) {
      res.status(400).json({ 
        message: "Cannot specify both websiteId and niche - choose one" 
      });
      return;
    }

    const VALID_LANGUAGES = [
      "english", "spanish", "french", "german", "italian", "portuguese",
      "russian", "japanese", "chinese", "korean", "dutch", "swedish",
      "polish", "turkish", "thai", "vietnamese"
    ];
    
    if (!VALID_LANGUAGES.includes(language)) {
      res.status(400).json({ 
        message: `Invalid language: ${language}. Must be one of: ${VALID_LANGUAGES.join(", ")}` 
      });
      return;
    }

    let website = null;
    if (websiteId) {
      website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(403).json({ message: "Website not found or access denied" });
        return;
      }
      console.log(`✅ Generating content for website: ${website.name}`);
    } else {
      console.log(`✅ Generating standalone content for niche: ${niche}`);
    }
    
    const { 
      topic, 
      keywords, 
      tone, 
      wordCount, 
      brandVoice, 
      targetAudience, 
      eatCompliance,
      aiProvider = 'openai',
      includeImages = false,
      imageCount = 0,
      imageStyle = 'natural',
      promptType = 'system',
      customPrompt
    } = contentData;
    
    if (!topic) {
      res.status(400).json({ message: "Topic is required" });
      return;
    }

    // 🍌 NEW: Determine image provider
    const imageProvider = imageStyle === 'nano_banana' ? 'imagen' : 'dalle';
    
    // Check for appropriate API key based on image provider
    if (includeImages) {
      const userApiKeys = await storage.getUserApiKeys(userId);
      
      if (imageProvider === 'imagen') {
        // Check for Google key (Nano Banana)
        const hasUserGoogleKey = userApiKeys.some(
          key => key.provider === 'google_gemini' && 
                 key.isActive && 
                 key.validationStatus === 'valid'
        );
        const hasSystemGoogleKey = !!process.env.GOOGLE_GEMINI_API_KEY;
        
        if (!hasUserGoogleKey && !hasSystemGoogleKey) {
          res.status(400).json({ 
            message: "Nano Banana requires a Google Gemini API key. Please add your Google API key in settings." 
          });
          return;
        }
        
        console.log(`🍌 Nano Banana available via ${hasUserGoogleKey ? 'user' : 'system'} Google key`);
      } else {
        // Check for OpenAI key (DALL-E)
        const hasUserOpenAIKey = userApiKeys.some(
          key => key.provider === 'openai' && 
                 key.isActive && 
                 key.validationStatus === 'valid'
        );
        const hasSystemOpenAIKey = !!(process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR);
        
        if (!hasUserOpenAIKey && !hasSystemOpenAIKey) {
          res.status(400).json({ 
            message: "Image generation requires an OpenAI API key. Please add your OpenAI API key in settings." 
          });
          return;
        }
        
        console.log(`🎨 DALL-E available via ${hasUserOpenAIKey ? 'user' : 'system'} OpenAI key`);
      }
    }

    if (includeImages && (imageCount < 1 || imageCount > 3)) {
      res.status(400).json({ 
        message: "Image count must be between 1 and 3" 
      });
      return;
    }

    if (aiProvider && !['openai', 'anthropic', 'gemini'].includes(aiProvider)) {
      res.status(400).json({ 
        message: "AI provider must be 'openai', 'anthropic', or 'gemini'" 
      });
      return;
    }

    console.log(`🤖 Generating ${websiteId ? 'website' : 'standalone'} content with ${aiProvider.toUpperCase()} in ${language.toUpperCase()} using ${promptType === 'custom' ? 'CUSTOM' : 'SYSTEM'} prompt for topic: ${topic}`);
    
    if (includeImages) {
      console.log(`🎨 Will generate ${imageCount} images with ${imageProvider === 'imagen' ? '🍌 Nano Banana (Google Imagen)' : 'DALL-E 3'}`);
    }

    let result;
    try {
      // Generate content first (let aiService handle DALL-E, but not Imagen)
      result = await aiService.generateContent({
        websiteId: websiteId || undefined,
        niche: niche || undefined,
        topic,
        keywords: keywords || [],
        tone: tone || "professional", 
        wordCount: wordCount || 800,
        seoOptimized: true,
        brandVoice: brandVoice || "professional",
        targetAudience,
        eatCompliance: eatCompliance || false,
        aiProvider: aiProvider as 'openai' | 'anthropic' | 'gemini',
        userId: userId,
        includeImages: includeImages && imageProvider === 'dalle', // Only DALL-E
        imageCount: imageProvider === 'dalle' ? imageCount : 0,
        imageStyle: imageProvider === 'dalle' ? imageStyle : 'natural',
        language: language,
        promptType: promptType as 'system' | 'custom',
        customPrompt: customPrompt,
      });
      // 🍌 NEW: Generate Nano Banana images separately if selected
if (includeImages && imageProvider === 'imagen') {
  console.log(`🍌 Generating ${imageCount} Nano Banana images...`);
  
  try {
    const nanoBananaResult = await nanoBananaImagenService.generateImages({
      topic: topic,
      count: imageCount,
      contentContext: result.content, // Pass content for better context
    }, userId, websiteId);

    // Convert base64 to data URLs and format for storage
    result.images = nanoBananaResult.images.map((img: any, idx: number) => ({
      url: `data:${img.mimeType};base64,${img.base64}`,
      base64: img.base64,
      mimeType: img.mimeType,
      altText: img.altText || `${topic} - Image ${idx + 1}`,
      prompt: img.prompt,
      cost: 0.04, // Imagen cost
      filename: `nano-banana-${Date.now()}-${idx}.png`,
      cloudinaryUrl: null,
      cloudinaryPublicId: null,
    }));
    
    result.totalImageCost = nanoBananaResult.totalCost;
    
    console.log(`✅ Generated ${nanoBananaResult.images.length} Nano Banana images for $${nanoBananaResult.totalCost.toFixed(4)}`);
    
    // 🔥 FIX: Insert images into content body using service method
    result.content = nanoBananaImagenService.insertImagesIntoContent(
      result.content, 
      result.images,
      'distributed' // Distributes images evenly throughout the content
    );
    console.log(`✅ Inserted ${result.images.length} images into content HTML`);
    
  } catch (imageError: any) {
    console.error('🍌 Nano Banana generation failed:', imageError);
    result.images = [];
    result.totalImageCost = 0;
  }
}

      // // 🍌 NEW: Generate Nano Banana images separately if selected
      // if (includeImages && imageProvider === 'imagen') {
      //   console.log(`🍌 Generating ${imageCount} Nano Banana images...`);
        
      //   try {
      //     const nanoBananaResult = await nanoBananaImagenService.generateImages({
      //       topic: topic,
      //       count: imageCount,
      //       contentContext: result.content, // Pass content for better context
      //     }, userId, websiteId);

      //     // Convert base64 to data URLs and format for storage
      //     result.images = nanoBananaResult.images.map((img: any, idx: number) => ({
      //       url: `data:${img.mimeType};base64,${img.base64}`,
      //       base64: img.base64,
      //       mimeType: img.mimeType,
      //       altText: img.altText || `${topic} - Image ${idx + 1}`,
      //       prompt: img.prompt,
      //       cost: 0.02, // Imagen cost
      //       filename: `nano-banana-${Date.now()}-${idx}.png`,
      //       cloudinaryUrl: null,
      //       cloudinaryPublicId: null,
      //     }));
          
      //     result.totalImageCost = nanoBananaResult.totalCost;
          
      //     console.log(`✅ Generated ${nanoBananaResult.images.length} Nano Banana images for $${nanoBananaResult.totalCost.toFixed(4)}`);
          
      //     // 🔥 FIX: Insert images into content body
      //     result.content = insertImagesIntoContent(result.content, result.images);
      //     console.log(`✅ Inserted ${result.images.length} images into content HTML`);
          
      //   } catch (imageError: any) {
      //     console.error('🍌 Nano Banana generation failed:', imageError);
      //     result.images = [];
      //     result.totalImageCost = 0;
      //   }
      // }
    } catch (error: any) {
      // Clear cache if API key error
      if (error.message?.includes('Invalid API key') || error.message?.includes('authentication')) {
        console.log('🔄 Clearing API key cache due to authentication error');
        aiService.clearApiKeyCache(userId, aiProvider as any);
        if (includeImages) {
          if (imageProvider === 'imagen') {
            nanoBananaImagenService.clearApiKeyCache(userId);
          } else {
            imageService.clearApiKeyCache(userId);
          }
        }
      }
      throw error;
    }

    // CHECK IF CONTENT WAS ALREADY SAVED
    let content;
    if (result.contentId) {
      console.log(`✅ Using already saved content with ID: ${result.contentId}`);
      content = await storage.getContent(result.contentId);
      
      if (!content) {
        throw new Error(`Content with ID ${result.contentId} not found after save`);
      }
      
      // 🔥 FIX: If we added images after content was saved, update the content body
      if (result.images && result.images.length > 0) {
        console.log(`🔄 Updating saved content with ${result.images.length} images...`);
        content = await storage.updateContent(content.id, {
          body: result.content,
          hasImages: true,
          imageCount: result.images.length,
          imageCostCents: Math.round((result.totalImageCost || 0) * 100),
        });
        console.log(`✅ Content updated with images`);
      }
    } else {
      console.log(`💾 Saving content (fallback path)...`);
      content = await storage.createContent({
        userId,
        websiteId: websiteId || null,
        niche: niche || null,
        title: result.title,
        body: result.content,
        excerpt: result.excerpt,
        metaDescription: result.metaDescription,
        metaTitle: result.metaTitle,
        seoScore: Math.max(1, Math.min(100, Math.round(result.seoScore))),
        readabilityScore: Math.max(1, Math.min(100, Math.round(result.readabilityScore))), 
        brandVoiceScore: Math.max(1, Math.min(100, Math.round(result.brandVoiceScore))),
        tokensUsed: Math.max(1, result.tokensUsed),
        costUsd: Math.max(1, Math.round((result.costUsd || 0.001) * 100)),
        eatCompliance: result.eatCompliance,
        seoKeywords: result.keywords,
        aiModel: aiProvider === 'openai' ? 'gpt-4o' : aiProvider === 'anthropic' ? 'claude-3-5-sonnet-20250106' : 'gemini-1.5-pro',
        hasImages: includeImages && result.images?.length > 0,
        imageCount: result.images?.length || 0,
        imageCostCents: Math.round((result.totalImageCost || 0) * 100),
        language: language,
      });
      
      console.log(`✅ Content saved with scores - SEO: ${content.seoScore}, Readability: ${content.readabilityScore}, Brand: ${content.brandVoiceScore}`);
    }

    // Save images to database if they exist (only if not already saved)
    if (result.images && result.images.length > 0 && !result.contentId) {
      for (const image of result.images) {
        await storage.createContentImage({
          contentId: content.id,
          userId,
          websiteId: websiteId || null,
          originalUrl: image.cloudinaryUrl || image.url,
          cloudinaryUrl: image.cloudinaryUrl,
          cloudinaryPublicId: image.cloudinaryPublicId,
          filename: image.filename,
          altText: image.altText,
          generationPrompt: image.prompt,
          costCents: Math.round(image.cost * 100),
          imageStyle,
          size: '1024x1024',
          status: 'generated'
        });
      }
    }

    // Create activity log (only if not already created)
    if (!result.contentId) {
      const imageProviderName = result.images?.length 
        ? (imageProvider === 'imagen' ? 'Google Imagen (Nano Banana)' : 'DALL-E 3')
        : null;
        
      await storage.createActivityLog({
        userId,
        websiteId: websiteId || null,
        type: "content_generated",
        description: `AI ${websiteId ? 'website' : 'standalone'} content generated in ${language.toUpperCase()} using ${promptType === 'custom' ? 'custom' : 'system'} prompt: "${result.title}" (${result.aiProvider.toUpperCase()}${imageProviderName ? ` + ${result.images.length} ${imageProviderName} images` : ''})`,
        metadata: { 
          contentId: content.id,
          contentType: websiteId ? 'website' : 'standalone',
          niche: niche || null,
          language: language,
          promptType: promptType,
          contentAiProvider: result.aiProvider,
          imageAiProvider: result.images?.length ? (imageProvider === 'imagen' ? 'google-imagen' : 'dall-e-3') : null,
          tokensUsed: content.tokensUsed,
          textCostCents: content.costUsd,
          hasImages: !!result.images?.length,
          imageCount: result.images?.length || 0,
          imageCostCents: Math.round((result.totalImageCost || 0) * 100),
          apiKeySource: {
            content: 'user',
            images: includeImages ? 'user' : null
          }
        }
      });
    }

    res.json({ content, aiResult: result });
  } catch (error) {
    console.error("Content generation error:", error);
    
    let statusCode = 500;
    let errorMessage = error instanceof Error ? error.message : "Failed to generate content";
    
    if (error instanceof Error) {
      if (error.name === 'AIProviderError') {
        statusCode = 400;
        if (error.message.includes('No API key available')) {
          errorMessage = error.message;
        }
      } else if (error.name === 'AnalysisError') {
        statusCode = 422;
        errorMessage = `Content generated successfully, but analysis failed: ${error.message}`;
      } else if (error.message.includes('Image generation failed')) {
        statusCode = 422;
        errorMessage = `Content generated successfully, but image generation failed: ${error.message}`;
      }
    }
    
    res.status(statusCode).json({ 
      message: errorMessage,
      error: error instanceof Error ? error.name : 'UnknownError'
    });
  }
});


// app.post("/api/user/content/generate", requireAuth, async (req: Request, res: Response): Promise<void> => {
//   try {
//     const userId = req.user!.id;
//     const { websiteId, niche, language = "english", ...contentData } = req.body; // ✅ ADD language with default
    
//     console.log('🔍 DEBUG: Raw request body:', {
//       websiteId: websiteId || 'none',
//       niche: niche || 'none',
//       language: language || 'english', // ✅ ADD
//       contentType: websiteId ? 'website' : 'standalone',
//       contentData: {
//         includeImages: contentData.includeImages,
//         imageCount: contentData.imageCount,
//         imageStyle: contentData.imageStyle,
//         aiProvider: contentData.aiProvider,
//         topic: contentData.topic
//       }
//     });

//     // Validate EITHER websiteId OR niche (not both, not neither)
//     if (!websiteId && !niche) {
//       res.status(400).json({ 
//         message: "Either websiteId or niche must be provided for content generation" 
//       });
//       return;
//     }
//     if (websiteId && niche) {
//       res.status(400).json({ 
//         message: "Cannot specify both websiteId and niche - choose one" 
//       });
//       return;
//     }

//     // ✅ ADD: Validate language
//     const VALID_LANGUAGES = [
//       "english", "spanish", "french", "german", "italian", "portuguese",
//       "russian", "japanese", "chinese", "korean", "dutch", "swedish",
//       "polish", "turkish", "thai", "vietnamese"
//     ];
    
//     if (!VALID_LANGUAGES.includes(language)) {
//       res.status(400).json({ 
//         message: `Invalid language: ${language}. Must be one of: ${VALID_LANGUAGES.join(", ")}` 
//       });
//       return;
//     }

//     // Only check website ownership IF websiteId is provided
//     let website = null;
//     if (websiteId) {
//       website = await storage.getUserWebsite(websiteId, userId);
//       if (!website) {
//         res.status(403).json({ message: "Website not found or access denied" });
//         return;
//       }
//       console.log(`✅ Generating content for website: ${website.name}`);
//     } else {
//       console.log(`✅ Generating standalone content for niche: ${niche}`);
//     }
    
//     const { 
//       topic, 
//       keywords, 
//       tone, 
//       wordCount, 
//       brandVoice, 
//       targetAudience, 
//       eatCompliance,
//       aiProvider = 'openai',
//       includeImages = false,
//       imageCount = 0,
//       imageStyle = 'natural',
//       promptType = 'system',        // ✅ ADD THIS with default
//       customPrompt                   // ✅ ADD THIS
//     } = contentData;
    
//     if (!topic) {
//       res.status(400).json({ message: "Topic is required" });
//       return;
//     }

//     // Check for user's OpenAI key OR environment key for images
//     if (includeImages) {
//       const userApiKeys = await storage.getUserApiKeys(userId);
//       const hasUserOpenAIKey = userApiKeys.some(
//         key => key.provider === 'openai' && 
//                key.isActive && 
//                key.validationStatus === 'valid'
//       );
//       const hasSystemOpenAIKey = !!(process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR);
      
//       if (!hasUserOpenAIKey && !hasSystemOpenAIKey) {
//         res.status(400).json({ 
//           message: "Image generation requires an OpenAI API key. Please add your OpenAI API key in settings or contact support." 
//         });
//         return;
//       }
      
//       console.log(`🎨 Image generation available via ${hasUserOpenAIKey ? 'user' : 'system'} OpenAI key`);
//     }

//     if (includeImages && (imageCount < 1 || imageCount > 3)) {
//       res.status(400).json({ 
//         message: "Image count must be between 1 and 3" 
//       });
//       return;
//     }

//     if (aiProvider && !['openai', 'anthropic', 'gemini'].includes(aiProvider)) {
//       res.status(400).json({ 
//         message: "AI provider must be 'openai', 'anthropic', or 'gemini'" 
//       });
//       return;
//     }

//     console.log(`🤖 Generating ${websiteId ? 'website' : 'standalone'} content with ${aiProvider.toUpperCase()} in ${language.toUpperCase()} using ${promptType === 'custom' ? 'CUSTOM' : 'SYSTEM'} prompt for topic: ${topic}`);
    
//     if (includeImages) {
//       console.log(`🎨 Will also generate ${imageCount} images with DALL-E 3`);
//     }

//     let result;
//     try {
//       result = await aiService.generateContent({
//         websiteId: websiteId || undefined,
//         niche: niche || undefined,
//         topic,
//         keywords: keywords || [],
//         tone: tone || "professional", 
//         wordCount: wordCount || 800,
//         seoOptimized: true,
//         brandVoice: brandVoice || "professional",
//         targetAudience,
//         eatCompliance: eatCompliance || false,
//         aiProvider: aiProvider as 'openai' | 'anthropic' | 'gemini',
//         userId: userId,
//         includeImages,
//         imageCount,
//         imageStyle,
//         language: language,
//         promptType: promptType as 'system' | 'custom',  // ✅ ADD THIS
//         customPrompt: customPrompt,                      // ✅ ADD THIS // ✅ ADD: Pass language to aiService
//       });
//     } catch (error: any) {
//       // Clear cache if API key error
//       if (error.message?.includes('Invalid API key') || error.message?.includes('authentication')) {
//         console.log('🔄 Clearing API key cache due to authentication error');
//         aiService.clearApiKeyCache(userId, aiProvider as any);
//         if (includeImages) {
//           imageService.clearApiKeyCache(userId);
//         }
//       }
//       throw error;
//     }

//     // CHECK IF CONTENT WAS ALREADY SAVED
//     let content;
//     if (result.contentId) {
//       console.log(`✅ Using already saved content with ID: ${result.contentId}`);
//       content = await storage.getContent(result.contentId);
      
//       if (!content) {
//         throw new Error(`Content with ID ${result.contentId} not found after save`);
//       }
//     } else {
//       console.log(`💾 Saving content (fallback path)...`);
//       content = await storage.createContent({
//         userId,
//         websiteId: websiteId || null,
//         niche: niche || null,
//         title: result.title,
//         body: result.content,
//         excerpt: result.excerpt,
//         metaDescription: result.metaDescription,
//         metaTitle: result.metaTitle,
//         seoScore: Math.max(1, Math.min(100, Math.round(result.seoScore))),
//         readabilityScore: Math.max(1, Math.min(100, Math.round(result.readabilityScore))), 
//         brandVoiceScore: Math.max(1, Math.min(100, Math.round(result.brandVoiceScore))),
//         tokensUsed: Math.max(1, result.tokensUsed),
//         costUsd: Math.max(1, Math.round((result.costUsd || 0.001) * 100)),
//         eatCompliance: result.eatCompliance,
//         seoKeywords: result.keywords,
//         aiModel: aiProvider === 'openai' ? 'gpt-4o' : aiProvider === 'anthropic' ? 'claude-3-5-sonnet-20250106' : 'gemini-1.5-pro',
//         hasImages: includeImages && result.images?.length > 0,
//         imageCount: result.images?.length || 0,
//         imageCostCents: Math.round((result.totalImageCost || 0) * 100),
//         language: language, // ✅ ADD: Save language to database
//       });
      
//       console.log(`✅ Content saved with scores - SEO: ${content.seoScore}, Readability: ${content.readabilityScore}, Brand: ${content.brandVoiceScore}`);
//     }

//     // Save images to database if they exist (only if not already saved)
//     if (result.images && result.images.length > 0 && !result.contentId) {
//       for (const image of result.images) {
//         await storage.createContentImage({
//           contentId: content.id,
//           userId,
//           websiteId: websiteId || null,
//           originalUrl: image.cloudinaryUrl || image.url,
//           cloudinaryUrl: image.cloudinaryUrl,
//           cloudinaryPublicId: image.cloudinaryPublicId,
//           filename: image.filename,
//           altText: image.altText,
//           generationPrompt: image.prompt,
//           costCents: Math.round(image.cost * 100),
//           imageStyle,
//           size: '1024x1024',
//           status: 'generated'
//         });
//       }
//     }

//     // Create activity log (only if not already created)
//     if (!result.contentId) {
//       await storage.createActivityLog({
//         userId,
//         websiteId: websiteId || null,
//         type: "content_generated",
//         description: `AI ${websiteId ? 'website' : 'standalone'} content generated in ${language.toUpperCase()}: "${result.title}" (${result.aiProvider.toUpperCase()}${result.images?.length ? ` + ${result.images.length} DALL-E images` : ''})`,
//         metadata: { 
//           contentId: content.id,
//           contentType: websiteId ? 'website' : 'standalone',
//           niche: niche || null,
//           language: language, // ✅ ADD: Log language
//           promptType: promptType,  // ✅ ADD: Track prompt type
//           contentAiProvider: result.aiProvider,
//           imageAiProvider: result.images?.length ? 'dall-e-3' : null,
//           tokensUsed: content.tokensUsed,
//           textCostCents: content.costUsd,
//           hasImages: !!result.images?.length,
//           imageCount: result.images?.length || 0,
//           imageCostCents: Math.round((result.totalImageCost || 0) * 100),
//           apiKeySource: {
//             content: 'user',
//             images: includeImages ? 'user' : null
//           }
//         }
//       });
//     }

//     res.json({ content, aiResult: result });
//   } catch (error) {
//     console.error("Content generation error:", error);
    
//     let statusCode = 500;
//     let errorMessage = error instanceof Error ? error.message : "Failed to generate content";
    
//     if (error instanceof Error) {
//       if (error.name === 'AIProviderError') {
//         statusCode = 400;
//         if (error.message.includes('No API key available')) {
//           errorMessage = error.message;
//         }
//       } else if (error.name === 'AnalysisError') {
//         statusCode = 422;
//         errorMessage = `Content generated successfully, but analysis failed: ${error.message}`;
//       } else if (error.message.includes('Image generation failed')) {
//         statusCode = 422;
//         errorMessage = `Content generated successfully, but image generation failed: ${error.message}`;
//       }
//     }
    
//     res.status(statusCode).json({ 
//       message: errorMessage,
//       error: error instanceof Error ? error.name : 'UnknownError'
//     });
//   }
// });


  // ADD: New endpoint to check image generation availability
  app.get("/api/user/image-generation/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      
      // Check for user's OpenAI key
      const userApiKeys = await storage.getUserApiKeys(userId);
      const hasUserOpenAIKey = userApiKeys.some(
        key => key.provider === 'openai' && 
               key.isActive && 
               key.validationStatus === 'valid'
      );
      
      // Check for system OpenAI key
      const hasSystemKey = !!(process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR);
      
      res.json({
        available: hasUserOpenAIKey || hasSystemKey,
        source: hasUserOpenAIKey ? 'user' : hasSystemKey ? 'system' : 'none',
        userKeyConfigured: hasUserOpenAIKey,
        systemKeyAvailable: hasSystemKey,
        message: !hasUserOpenAIKey && !hasSystemKey 
          ? 'Image generation requires an OpenAI API key. Please add one in settings.'
          : hasUserOpenAIKey
          ? 'Image generation available using your OpenAI API key'
          : 'Image generation available using system OpenAI API key'
      });
    } catch (error) {
      console.error("Failed to check image generation status:", error);
      res.status(500).json({ 
        available: false, 
        source: 'none',
        userKeyConfigured: false,
        systemKeyAvailable: false,
        message: 'Failed to check image generation status' 
      });
    }
  });

  app.put("/api/user/content/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const contentId = req.params.id;
      const { 
        websiteId, 
        aiProvider, 
        regenerateImages = false,
        includeImages = false,
        imageCount = 0,
        imageStyle = 'natural',
        promptType = 'system',        // ✅ ADD THIS
        customPrompt,                  // ✅ ADD THIS
        ...updateData 
      } = req.body;
      
          // ✅ ADD DEBUG LOG
    console.log('🔍 [PUT Route] Received prompt fields:', {
      promptType,
      hasCustomPrompt: !!customPrompt,
      customPromptLength: customPrompt?.length || 0
    });


      console.log('DEBUG: Content update parameters:', {
        contentAI: aiProvider,
        regenerateImages,
        includeImages,
        imageCount,
        imageStyle,
        promptType,  // ✅ ADD TO LOG
      });
      
      if (websiteId) {
        const website = await storage.getUserWebsite(websiteId, userId);
        if (!website) {
          res.status(403).json({ message: "Website not found or access denied" });
          return;
        }
      }
      
      let regenerationResult = null;
      if (aiProvider && updateData.title && updateData.body) {
        try {
          console.log(`Content AI: ${aiProvider.toUpperCase()}, Image AI: ${(regenerateImages || includeImages) ? 'DALL-E 3' : 'None'}, Prompt: ${promptType === 'custom' ? 'CUSTOM' : 'SYSTEM'}`);
          
          const existingContent = await storage.getContent(contentId);
          const hasExistingImages = existingContent?.hasImages || false;
          const existingImageCount = existingContent?.imageCount || 0;
          
          let shouldIncludeImages = false;
          let finalImageCount = 0;
          let finalImageStyle = imageStyle || 'natural';
          
          if (regenerateImages) {
            if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY_ENV_VAR) {
              throw new Error('Image regeneration requires OpenAI API key for DALL-E 3');
            }
            shouldIncludeImages = true;
            finalImageCount = imageCount || existingImageCount || 1;
            console.log('Will regenerate images with DALL-E:', { finalImageCount, finalImageStyle });
          } else if (!regenerateImages && hasExistingImages) {
            shouldIncludeImages = false;
            finalImageCount = 0;
            console.log('Will keep existing images');
          } else if (includeImages) {
            if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY_ENV_VAR) {
              throw new Error('Image generation requires OpenAI API key for DALL-E 3');
            }
            shouldIncludeImages = true;
            finalImageCount = imageCount || 1;
            console.log('Will add new images with DALL-E:', { finalImageCount, finalImageStyle });
          }
          
          const keywords = Array.isArray(updateData.seoKeywords) ? 
            updateData.seoKeywords : 
            (typeof updateData.seoKeywords === 'string' ? 
              updateData.seoKeywords.split(',').map(k => k.trim()) : []);

          console.log('Generation parameters:', {
            contentProvider: aiProvider,
            imageProvider: shouldIncludeImages ? 'dall-e-3' : 'none',
            promptType,  // ✅ ADD TO LOG
            topic: updateData.title,
            includeImages: shouldIncludeImages,
            imageCount: finalImageCount
          });

          regenerationResult = await aiService.generateContent({
            websiteId: websiteId || contentId,
            topic: updateData.title,
            keywords: keywords,
            tone: updateData.tone || 'professional',
            wordCount: updateData.body ? updateData.body.split(' ').length : 800,
            seoOptimized: true,
            brandVoice: updateData.brandVoice,
            targetAudience: updateData.targetAudience,
            eatCompliance: updateData.eatCompliance || false,
            aiProvider: aiProvider as 'openai' | 'anthropic' | 'gemini',
            userId: userId,
            includeImages: shouldIncludeImages,
            imageCount: finalImageCount,
            imageStyle: finalImageStyle,
            promptType: promptType as 'system' | 'custom',  // ✅ ADD THIS
            customPrompt: customPrompt,                      // ✅ ADD THIS
          });

          if (regenerationResult) {
            console.log('Regeneration completed:', {
              contentAI: aiProvider,
              imageAI: shouldIncludeImages ? 'dall-e-3' : 'none',
              promptType,  // ✅ ADD TO LOG
              hasImages: !!regenerationResult.images?.length,
              imageCount: regenerationResult.images?.length || 0,
              textCost: regenerationResult.costUsd,
              imageCost: regenerationResult.totalImageCost || 0
            });

            updateData.title = regenerationResult.title;
            updateData.body = regenerationResult.content;
            updateData.excerpt = regenerationResult.excerpt;
            updateData.metaDescription = regenerationResult.metaDescription;
            updateData.metaTitle = regenerationResult.metaTitle;
            updateData.seoKeywords = regenerationResult.keywords;

            updateData.seoScore = Math.max(1, Math.min(100, Math.round(regenerationResult.seoScore)));
            updateData.readabilityScore = Math.max(1, Math.min(100, Math.round(regenerationResult.readabilityScore)));
            updateData.brandVoiceScore = Math.max(1, Math.min(100, Math.round(regenerationResult.brandVoiceScore)));
            
            updateData.tokensUsed = Math.max(1, Math.round(regenerationResult.tokensUsed));
            updateData.costUsd = Math.max(1, Math.round(regenerationResult.costUsd * 100));
            
            updateData.hasImages = !!regenerationResult.images?.length;
            updateData.imageCount = regenerationResult.images?.length || 0;
            updateData.imageCostCents = Math.round((regenerationResult.totalImageCost || 0) * 100);

            updateData.aiModel = aiProvider === 'openai' ? 'gpt-4o' : 
                                  aiProvider === 'anthropic' ? 'claude-3-5-sonnet-20250106' : 
                                  'gemini-1.5-pro';

            console.log(`Content regenerated with ${aiProvider.toUpperCase()}, images with DALL-E - SEO: ${updateData.seoScore}%, Images: ${updateData.imageCount}`);
            
            if (regenerationResult.images && regenerationResult.images.length > 0) {
              console.log(`Saving ${regenerationResult.images.length} DALL-E images to database`);
              
              if (regenerateImages) {
                await storage.deleteContentImages(contentId);
                console.log('Deleted existing images for regeneration');
              }
              
              for (const image of regenerationResult.images) {
                await storage.createContentImage({
                  contentId: contentId,
                  userId,
                  websiteId: websiteId || existingContent.websiteId,
                  originalUrl: image.url,
                  filename: image.filename,
                  altText: image.altText,
                  generationPrompt: image.prompt,
                  costCents: Math.round(image.cost * 100),
                  imageStyle: finalImageStyle,
                  size: '1024x1024',
                  status: 'generated'
                });
              }
            }
          }
        } catch (regenerationError) {
          console.error(`Content regeneration failed:`, regenerationError);
        }
      }
      
      const updatedContent = await storage.updateContent(contentId, updateData);
      if (!updatedContent) {
        res.status(404).json({ message: "Content not found" });
        return;
      }

      if (regenerationResult && websiteId) {
        try {
          const hasImages = regenerationResult.images?.length > 0;
          const activityDescription = hasImages 
            ? `Content regenerated with ${aiProvider?.toUpperCase()}, images with DALL-E: "${updatedContent.title}"`
            : `Content regenerated with ${aiProvider?.toUpperCase()}: "${updatedContent.title}"`;
            
          await storage.createActivityLog({
            userId,
            websiteId,
            type: "content_regenerated",
            description: activityDescription,
            metadata: { 
              contentId: updatedContent.id,
              contentAiProvider: aiProvider,
              imageAiProvider: hasImages ? 'dall-e-3' : null,
              promptType,  // ✅ ADD TO METADATA
              tokensUsed: updateData.tokensUsed,
              textCostCents: updateData.costUsd,
              regenerated: !!regenerationResult,
              imagesRegenerated: regenerateImages,
              newImageCount: regenerationResult?.images?.length || 0,
              imageCostCents: Math.round((regenerationResult?.totalImageCost || 0) * 100)
            }
          });
        } catch (logError) {
          console.warn("Failed to log activity:", logError);
        }
      }

      res.json({ 
        content: updatedContent,
        regeneration: regenerationResult ? {
          success: true,
          contentAiProvider: aiProvider,
          imageAiProvider: regenerationResult.images?.length > 0 ? 'dall-e-3' : null,
          promptType,  // ✅ ADD TO METADATA
          tokensUsed: regenerationResult.tokensUsed,
          costUsd: regenerationResult.costUsd,
          seoScore: regenerationResult.seoScore,
          readabilityScore: regenerationResult.readabilityScore,
          brandVoiceScore: regenerationResult.brandVoiceScore,
          imagesRegenerated: regenerateImages,
          newImageCount: regenerationResult.images?.length || 0,
          imageCostUsd: regenerationResult.totalImageCost || 0
        } : null
      });
    } catch (error) {
      console.error("Content update error:", error);
      
      let statusCode = 500;
      let errorMessage = "Failed to update content";
      
      if (error instanceof Error) {
        errorMessage = error.message;
        if (error.name === 'ValidationError') {
          statusCode = 400;
        } else if (error.name === 'AIProviderError') {
          statusCode = 400;
          errorMessage = `Content regeneration failed: ${error.message}`;
        }
      }
      
      res.status(statusCode).json({ 
        message: errorMessage,
        error: error instanceof Error ? error.name : 'UnknownError'
      });
    }
  });

  app.post("/api/user/content/:id/publish", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const contentId = req.params.id;
      
      console.log(`📢 Publishing content ${contentId} for user ${userId}`);
      
      const content = await storage.getContent(contentId);
      if (!content || content.userId !== userId) {
        res.status(404).json({ message: "Content not found or access denied" });
        return;
      }

      const website = await storage.getUserWebsite(content.websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      if (content.wordpressPostId && content.status === "published") {
        res.status(400).json({ 
          message: "Content already published to WordPress",
          wordpressPostId: content.wordpressPostId,
          wordpressUrl: content.wordpressUrl || `${website.url}/?p=${content.wordpressPostId}`
        });
        return;
      }

      const wpCredentials = {
        applicationName: 'AI Content Manager',
        applicationPassword: 'nm48 i9wF QyBG 4ZzS AtOi FppB',
        username: website.wpUsername || 'info@murrayimmeubles.com'
      };

      console.log(`🔐 Using WordPress credentials:`);
      console.log(`- URL: ${website.url}`);
      console.log(`- Username: ${wpCredentials.username}`);
      console.log(`- Password: ${wpCredentials.applicationPassword.substring(0, 10)}...`);

      console.log(`🔗 Testing WordPress connection for ${website.url}...`);
      
      const connectionTest = await wordPressAuthService.testConnectionWithDiagnostics(
        website.url,
        wpCredentials
      );

      if (!connectionTest.success) {
        console.error('⌠ WordPress connection failed:', connectionTest.error);
        console.log('Full diagnostics:', connectionTest.diagnostics);
        
        res.status(400).json({ 
          message: `Cannot connect to WordPress: ${connectionTest.error}`,
          error: 'WP_CONNECTION_FAILED',
          diagnostics: connectionTest.diagnostics,
          troubleshooting: connectionTest.diagnostics?.recommendations || [
            "Verify WordPress URL is correct and accessible",
            "Check Application Password is valid and not expired", 
            "Ensure WordPress REST API is enabled",
            "Check firewall/security plugin settings",
            "Verify user has publishing permissions"
          ]
        });
        return;
      }

      console.log(`✅ WordPress connection successful!`);
      console.log('User info:', connectionTest.userInfo);

      const postData = {
        title: content.title,
        content: content.body,
        excerpt: content.excerpt || '',
        status: 'publish' as const,
        meta: {
          description: content.metaDescription || content.excerpt || '',
          title: content.metaTitle || content.title
        }
      };

      let wpResult;
      try {
        if (content.wordpressPostId) {
          console.log(`🔄 Updating existing WordPress post ${content.wordpressPostId}`);
          wpResult = await wordpressService.updatePost(
            {
              url: website.url,
              username: wpCredentials.username,
              applicationPassword: wpCredentials.applicationPassword
            }, 
            content.wordpressPostId, 
            postData
          );
        } else {
          console.log(`🆕 Creating new WordPress post`);
          wpResult = await wordpressService.publishPost(
            {
              url: website.url,
              username: wpCredentials.username,
              applicationPassword: wpCredentials.applicationPassword
            }, 
            postData
          );
        }
      } catch (wpError) {
        console.error("⌠ WordPress publish error:", wpError);
        
        await storage.updateContent(contentId, {
          status: "publish_failed",
          publishError: wpError instanceof Error ? wpError.message : 'Unknown WordPress error'
        });

        res.status(500).json({ 
          message: wpError instanceof Error ? wpError.message : "Failed to publish to WordPress",
          error: 'WP_PUBLISH_FAILED'
        });
        return;
      }

      const updatedContent = await storage.updateContent(contentId, {
        status: "published",
        publishDate: new Date(),
        wordpressPostId: wpResult.id,
        wordpressUrl: wpResult.link,
        publishError: null
      });

      await storage.createActivityLog({
        userId,
        websiteId: content.websiteId,
        type: "content_published", 
        description: `Content published to WordPress: "${content.title}"`,
        metadata: { 
          contentId: content.id,
          wordpressPostId: wpResult.id,
          wordpressUrl: wpResult.link,
          publishMethod: content.wordpressPostId ? 'update' : 'create'
        }
      });

      console.log(`🎉 Content published successfully! Post ID: ${wpResult.id}`);

      res.json({
        success: true,
        content: updatedContent,
        wordpress: {
          postId: wpResult.id,
          url: wpResult.link,
          status: wpResult.status
        },
        message: "Content published to WordPress successfully",
        debug: {
          connectionDiagnostics: connectionTest.diagnostics
        }
      });

    } catch (error) {
      console.error("⌠ Publish endpoint error:", error);
      
      const errorMessage = error instanceof Error ? error.message : "Failed to publish content";
      res.status(500).json({ 
        message: errorMessage,
        error: 'PUBLISH_FAILED'
      });
    }
  });

 app.post("/api/user/content/upload-images", 
  requireAuth, 
  upload.array('images', 10), 
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const { websiteId, contentId } = req.body;
      const files = req.files as Express.Multer.File[];
      
      console.log(`🖼️ Uploading ${files?.length || 0} images for user ${userId}`);
      
      if (!files || files.length === 0) {
        res.status(400).json({ 
          error: 'No images provided',
          message: 'Please select at least one image to upload' 
        });
        return;
      }
      
      // Verify access to website if specified
      if (websiteId && websiteId !== 'undefined') {
        const website = await storage.getUserWebsite(websiteId, userId);
        if (!website) {
          res.status(403).json({ 
            error: 'Access denied',
            message: 'Website not found or access denied' 
          });
          return;
        }
      }
      
      // Verify access to content if specified
      if (contentId && contentId !== 'undefined') {
        const content = await storage.getContent(contentId);
        if (!content || content.userId !== userId) {
          res.status(403).json({ 
            error: 'Access denied',
            message: 'Content not found or access denied' 
          });
          return;
        }
      }
      
      // Check if Cloudinary is configured
      if (!cloudinaryStorage.isConfigured()) {
        console.warn('⚠️ Cloudinary not configured, falling back to data URLs');
        // Fallback to data URLs if Cloudinary not configured
        const uploadedImages = [];
        for (const file of files) {
          const base64 = file.buffer.toString('base64');
          const dataUrl = `data:${file.mimetype};base64,${base64}`;
          
          uploadedImages.push({
            id: `upload_${Date.now()}_${uploadedImages.length}`,
            url: dataUrl,
            filename: file.originalname,
            altText: file.originalname.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " "),
            size: file.size,
            mimetype: file.mimetype
          });
        }
        
        res.json({
          success: true,
          images: uploadedImages,
          message: `Uploaded ${uploadedImages.length} image(s) (using data URLs - Cloudinary not configured)`,
          warning: 'Cloudinary not configured. Images stored as data URLs which may impact performance.'
        });
        return;
      }
      
      // Upload to Cloudinary
      const uploadedImages = [];
      const effectiveWebsiteId = websiteId || 'user-uploads';
      const effectiveContentId = contentId || `manual-${Date.now()}`;
      
      for (const file of files) {
        try {
          console.log(`📤 Uploading ${file.originalname} to Cloudinary...`);
          
          // Upload buffer to Cloudinary
          const cloudinaryResult = await cloudinaryStorage.uploadFromBuffer(
            file.buffer,
            effectiveWebsiteId,
            effectiveContentId,
            file.originalname
          );
          
          const imageData = {
            id: `cloudinary_${Date.now()}_${uploadedImages.length}`,
            url: cloudinaryResult.secureUrl,
            cloudinaryUrl: cloudinaryResult.secureUrl,
            cloudinaryPublicId: cloudinaryResult.publicId,
            filename: file.originalname,
            altText: file.originalname.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " "),
            size: cloudinaryResult.bytes,
            width: cloudinaryResult.width,
            height: cloudinaryResult.height,
            format: cloudinaryResult.format,
            mimetype: file.mimetype
          };
          
          uploadedImages.push(imageData);
          
          // Save to database if contentId is provided
          if (contentId && storage.createContentImage) {
            try {
              await storage.createContentImage({
                contentId,
                userId,
                websiteId: websiteId || '',
                originalUrl: cloudinaryResult.secureUrl,
                cloudinaryUrl: cloudinaryResult.secureUrl,
                cloudinaryPublicId: cloudinaryResult.publicId,
                filename: file.originalname,
                altText: imageData.altText,
                size: cloudinaryResult.bytes,
                status: 'uploaded'
              });
              console.log(`✅ Saved image metadata to database: ${file.originalname}`);
            } catch (dbError: any) {
              console.warn(`Could not save to database: ${dbError.message}`);
              // Continue anyway - image is still uploaded to Cloudinary
            }
          }
          
        } catch (uploadError: any) {
          console.error(`Failed to upload ${file.originalname}:`, uploadError);
          // Continue with other images even if one fails
        }
      }
      
      if (uploadedImages.length === 0) {
        res.status(500).json({ 
          error: 'Upload failed',
          message: 'Failed to upload any images to Cloudinary' 
        });
        return;
      }
      
      console.log(`✅ Successfully uploaded ${uploadedImages.length} images to Cloudinary`);
      
      res.json({
        success: true,
        images: uploadedImages,
        message: `Successfully uploaded ${uploadedImages.length} image(s) to Cloudinary`,
        storage: 'cloudinary'
      });
      
    } catch (error: any) {
      console.error('Image upload error:', error);
      res.status(500).json({ 
        error: 'Upload failed',
        message: error.message || 'Failed to upload images' 
      });
    }
  }
);

app.delete("/api/user/content/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const contentId = req.params.id;
    
    console.log(`🗑️ Deleting content ${contentId} for user ${userId}`);
    
    // Verify content exists and belongs to user first
    const contentItem = await storage.getContent(contentId);
    if (!contentItem) {
      res.status(404).json({ message: "Content not found" });
      return;
    }
    
    if (contentItem.userId !== userId) {
      res.status(403).json({ message: "Access denied - you don't own this content" });
      return;
    }
    
    // Perform the deletion
    const deleted = await storage.deleteContent(contentId, userId);
    
    if (!deleted) {
      res.status(500).json({ message: "Failed to delete content" });
      return;
    }
    
    // Log the activity
    try {
      await storage.createActivityLog({
        userId,
        websiteId: contentItem.websiteId,
        type: "content_deleted",
        description: `Content deleted: "${contentItem.title}"`,
        metadata: {
          contentId: contentItem.id,
          contentTitle: contentItem.title,
          wasPublished: contentItem.status === 'published',
          wordpressPostId: contentItem.wordpressPostId || null
        }
      });
    } catch (logError) {
      console.warn("Failed to create activity log for deletion:", logError);
      // Don't fail the deletion just because logging failed
    }
    
    console.log(`✅ Content ${contentId} deleted successfully`);
    
    res.json({
      success: true,
      message: "Content deleted successfully",
      deletedId: contentId
    });
    
  } catch (error) {
    console.error("Content deletion error:", error);
    res.status(500).json({
      message: error instanceof Error ? error.message : "Failed to delete content",
      error: 'DELETE_FAILED'
    });
  }
});
  

  // ===========================================================================
  // CONTENT SCHEDULING ROUTES
  // ===========================================================================



// ===========================================================================
// CONTENT SCHEDULING ROUTES WITH TIMEZONE SUPPORT
// ===========================================================================

app.get("/api/user/websites/:id/content-schedule", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    const scheduledContent = await storage.getContentSchedule(websiteId);
    
    // Get user's timezone from settings for display purposes
    const userSettings = await storage.getUserSettings(userId);
    const userTimezone = userSettings?.profile?.timezone || 'UTC';
    
    // Enhance scheduled content with timezone info
    const enhancedContent = scheduledContent.map((schedule: any) => ({
      ...schedule,
      userTimezone,
      // Include display-friendly time if timezone differs
      localScheduledDate: schedule.timezone && schedule.timezone !== userTimezone 
        ? convertUTCToLocalTime(schedule.scheduled_date, userTimezone)
        : null
    }));
    
    res.json(enhancedContent);
  } catch (error) {
    console.error("Failed to fetch content schedule:", error);
    res.status(500).json({ message: "Failed to fetch content schedule" });
  }
});

app.post("/api/user/websites/:id/schedule-content", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;
    const { 
      contentId, 
      scheduledDate, 
      timezone,
      localTime, // Optional: if provided, use this instead of scheduledDate
      publishDelay = 0 // Hours to delay after scheduled time
    } = req.body;
    
    console.log('📅 Scheduling existing content:', { 
      websiteId, 
      contentId, 
      scheduledDate, 
      timezone,
      localTime 
    });
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    const content = await storage.getContent(contentId);
    if (!content || content.userId !== userId || content.websiteId !== websiteId) {
      res.status(404).json({ message: "Content not found or access denied" });
      return;
    }
    
    if (content.status === 'published') {
      res.status(400).json({ message: "Content is already published" });
      return;
    }
    
    if (!contentId || (!scheduledDate && !localTime)) {
      res.status(400).json({ message: "Content ID and scheduled date/time are required" });
      return;
    }
    
    // Get user's timezone if not provided
    let scheduleTimezone = timezone;
    if (!scheduleTimezone) {
      const userSettings = await storage.getUserSettings(userId);
      scheduleTimezone = userSettings?.profile?.timezone || 'UTC';
    }
    
    // Handle scheduling time
    let scheduleTime: Date;
    let utcTime: string | null = null;
    let localTimeDisplay: string | null = null;
    
    if (localTime && timezone) {
      // Convert local time to UTC for storage
      const [hours, minutes] = localTime.split(':').map(Number);
      const now = new Date();
      scheduleTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
      
      // Store both local and UTC representations
      utcTime = convertLocalTimeToUTC(localTime, timezone);
      localTimeDisplay = `${localTime} ${timezone}`;
      
      console.log(`🕐 Converting ${localTimeDisplay} to UTC: ${utcTime}`);
    } else {
      // Use the provided scheduledDate directly
      scheduleTime = new Date(scheduledDate);
    }
    
    // Add publish delay if specified
    if (publishDelay > 0) {
      scheduleTime = new Date(scheduleTime.getTime() + publishDelay * 60 * 60 * 1000);
    }
    
    // Validate schedule time is in the future
    if (scheduleTime <= new Date()) {
      res.status(400).json({ message: "Scheduled date must be in the future" });
      return;
    }
    
    const existingSchedule = await storage.getContentScheduleByContentId(contentId);
    if (existingSchedule) {
      res.status(400).json({ message: "This content is already scheduled for publication" });
      return;
    }
    
    const scheduledContent = await storage.createContentSchedule({
      userId,
      websiteId,
      scheduledDate: scheduleTime,
      topic: content.title,
      keywords: content.seoKeywords || [],
      contentId,
      status: "scheduled",
      // Add timezone fields
      timezone: scheduleTimezone,
      metadata: {
        utcTime,
        localTime,
        localTimeDisplay,
        publishDelay,
        originalScheduledDate: scheduledDate,
        isManualSchedule: true
      }
    });
    
    await storage.createActivityLog({
      userId,
      websiteId,
      type: "content_scheduled",
      description: `Content scheduled for publication: "${content.title}" on ${scheduleTime.toLocaleString()} ${scheduleTimezone}`,
      metadata: { 
        scheduleId: scheduledContent.id,
        contentId,
        contentTitle: content.title,
        scheduledDate: scheduleTime.toISOString(),
        timezone: scheduleTimezone,
        localTimeDisplay
      }
    });
    
    console.log('✅ Content scheduled successfully:', {
      scheduleId: scheduledContent.id,
      timezone: scheduleTimezone,
      localTime: localTimeDisplay
    });
    
    res.status(201).json({
      ...scheduledContent,
      contentTitle: content.title,
      contentExcerpt: content.excerpt,
      seoKeywords: content.seoKeywords,
      timezone: scheduleTimezone,
      localTimeDisplay
    });
    
  } catch (error) {
    console.error("Failed to schedule content:", error);
    res.status(500).json({ 
      message: "Failed to schedule content",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.put("/api/user/websites/:websiteId/content-schedule/:scheduleId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId, scheduleId } = req.params;
    const { 
      scheduledDate, 
      status, 
      timezone,
      localTime 
    } = req.body;
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    const scheduleItem = await storage.getContentScheduleById(scheduleId);
    if (!scheduleItem || scheduleItem.userId !== userId) {
      res.status(404).json({ message: "Scheduled content not found or access denied" });
      return;
    }
    
    const updates: any = {};
    
    // Handle timezone-aware date updates
    if (scheduledDate !== undefined || localTime !== undefined) {
      let scheduleTime: Date;
      let scheduleTimezone = timezone || scheduleItem.timezone || 'UTC';
      
      if (localTime && timezone) {
        // Convert local time to date
        const [hours, minutes] = localTime.split(':').map(Number);
        const now = new Date();
        scheduleTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        
        // Store timezone info
        updates.timezone = scheduleTimezone;
        updates.metadata = {
          ...scheduleItem.metadata,
          localTime,
          localTimeDisplay: `${localTime} ${scheduleTimezone}`,
          utcTime: convertLocalTimeToUTC(localTime, scheduleTimezone)
        };
      } else {
        scheduleTime = new Date(scheduledDate);
      }
      
      if (scheduleTime <= new Date() && status !== 'cancelled') {
        res.status(400).json({ message: "Scheduled date must be in the future unless cancelling" });
        return;
      }
      
      updates.scheduledDate = scheduleTime;
    }
    
    if (status !== undefined) {
      updates.status = status;
    }
    
    if (timezone !== undefined && !updates.timezone) {
      updates.timezone = timezone;
    }
    
    const updatedSchedule = await storage.updateContentSchedule(scheduleId, updates);
    
    await storage.createActivityLog({
      userId,
      websiteId,
      type: "content_schedule_updated",
      description: `Publication schedule updated for content`,
      metadata: { 
        scheduleId,
        updates: Object.keys(updates),
        timezone: updates.timezone || scheduleItem.timezone
      }
    });
    
    res.json(updatedSchedule);
    
  } catch (error) {
    console.error("Failed to update scheduled content:", error);
    res.status(500).json({ 
      message: "Failed to update scheduled content",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.delete("/api/user/websites/:websiteId/content-schedule/:scheduleId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId, scheduleId } = req.params;
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    const scheduleItem = await storage.getContentScheduleById(scheduleId);
    if (!scheduleItem || scheduleItem.userId !== userId) {
      res.status(404).json({ message: "Scheduled content not found or access denied" });
      return;
    }
    
    const content = await storage.getContent(scheduleItem.contentId);
    
    const deleted = await storage.deleteContentSchedule(scheduleId);
    
    if (!deleted) {
      res.status(404).json({ message: "Scheduled content not found" });
      return;
    }
    
    await storage.createActivityLog({
      userId,
      websiteId,
      type: "content_schedule_deleted",
      description: `Publication schedule removed: "${content?.title || 'Unknown'}"`,
      metadata: { 
        scheduleId,
        contentId: scheduleItem.contentId,
        contentTitle: content?.title,
        wasScheduledFor: scheduleItem.scheduledDate,
        timezone: scheduleItem.timezone
      }
    });
    
    res.status(204).send();
    
  } catch (error) {
    console.error("Failed to delete scheduled content:", error);
    res.status(500).json({ 
      message: "Failed to delete scheduled content",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ===========================================================================
// HELPER FUNCTIONS FOR TIMEZONE CONVERSION
// ===========================================================================

/**
 * Convert local time to UTC
 */
function convertLocalTimeToUTC(localTime: string, timezone: string): string {
  try {
    const [hours, minutes] = localTime.split(':').map(Number);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const date = now.getDate();
    
    // Create a date in the user's timezone
    const localDateStr = new Date(year, month, date, hours, minutes).toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    // Parse and convert to UTC
    const [datePart, timePart] = localDateStr.split(', ');
    const [localMonth, localDay, localYear] = datePart.split('/').map(Number);
    const [localHour, localMinute] = timePart.split(':').map(Number);
    
    const localDate = new Date(localYear, localMonth - 1, localDay, localHour, localMinute);
    const utcHours = localDate.getUTCHours();
    const utcMinutes = localDate.getUTCMinutes();
    
    return `${String(utcHours).padStart(2, '0')}:${String(utcMinutes).padStart(2, '0')}`;
  } catch (error) {
    console.error('Error converting time to UTC:', error);
    return localTime; // Fallback to treating as UTC
  }
}

/**
 * Convert UTC date to local timezone for display
 */
function convertUTCToLocalTime(utcDate: Date | string, timezone: string): string {
  try {
    const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
    
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    console.error('Error converting UTC to local time:', error);
    return new Date(utcDate).toISOString();
  }
}

app.get("/api/user/content-schedule", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    
    const websites = await storage.getUserWebsites(userId);
    const allScheduledContent = [];
    
    for (const website of websites) {
      const schedules = await storage.getContentScheduleWithDetails(website.id);
      const schedulesWithWebsite = schedules.map(schedule => ({
        ...schedule,
        websiteName: website.name,
        websiteUrl: website.url,
        // Add timezone information if available
        timezone: schedule.timezone || 'UTC',
        // Convert scheduled date to user's timezone for display
        localScheduledDate: schedule.scheduledDate ? 
          new Date(schedule.scheduledDate).toLocaleString('en-US', {
            timeZone: schedule.timezone || 'UTC',
            dateStyle: 'medium',
            timeStyle: 'short'
          }) : null
      }));
      allScheduledContent.push(...schedulesWithWebsite);
    }
    
    // Sort by scheduled date
    allScheduledContent.sort((a, b) => 
      new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
    );
    
    res.json(allScheduledContent);
  } catch (error) {
    console.error("Failed to fetch user's scheduled content:", error);
    res.status(500).json({ message: "Failed to fetch scheduled content" });
  }
});











// Create new content schedule with timezone support
app.post("/api/user/websites/:id/schedule-content", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;
    const { 
      contentId, 
      scheduledDate, 
      timezone = 'UTC' // Default to UTC if not provided
    } = req.body;
    
    console.log('📅 Scheduling content:', { websiteId, contentId, scheduledDate, timezone });
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    const content = await storage.getContent(contentId);
    if (!content || content.userId !== userId || content.websiteId !== websiteId) {
      res.status(404).json({ message: "Content not found or access denied" });
      return;
    }
    
    if (content.status === 'published') {
      res.status(400).json({ message: "Content is already published" });
      return;
    }
    
    if (!contentId || !scheduledDate) {
      res.status(400).json({ message: "Content ID and scheduled date are required" });
      return;
    }
    
    // Parse the scheduled date and validate it's in the future
    const scheduleTime = new Date(scheduledDate);
    const nowInTimezone = new Date().toLocaleString('en-US', { timeZone: timezone });
    const nowInTimezoneDate = new Date(nowInTimezone);
    
    if (scheduleTime <= nowInTimezoneDate) {
      res.status(400).json({ 
        message: `Scheduled date must be in the future (current time in ${timezone} is ${nowInTimezone})` 
      });
      return;
    }
    
    const existingSchedule = await storage.getContentScheduleByContentId(contentId);
    if (existingSchedule) {
      res.status(400).json({ message: "This content is already scheduled for publication" });
      return;
    }
    
    const scheduledContent = await storage.createContentSchedule({
      userId,
      websiteId,
      scheduledDate: scheduleTime,
      timezone, // Store the timezone
      topic: content.title,
      keywords: content.seoKeywords || [],
      contentId,
      status: "scheduled"
    });
    
    await storage.createActivityLog({
      userId,
      websiteId,
      type: "content_scheduled",
      description: `Content scheduled for publication: "${content.title}" on ${scheduleTime.toLocaleString('en-US', { timeZone: timezone })} ${timezone}`,
      metadata: { 
        scheduleId: scheduledContent.id,
        contentId,
        contentTitle: content.title,
        scheduledDate: scheduledDate,
        timezone
      }
    });
    
    console.log('✅ Content scheduled successfully:', scheduledContent.id, 'in timezone:', timezone);
    res.status(201).json({
      ...scheduledContent,
      contentTitle: content.title,
      contentExcerpt: content.excerpt,
      seoKeywords: content.seoKeywords,
      timezone
    });
    
  } catch (error) {
    console.error("Failed to schedule content:", error);
    res.status(500).json({ 
      message: "Failed to schedule content",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Update scheduled content with timezone support
app.put("/api/user/websites/:websiteId/content-schedule/:scheduleId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId, scheduleId } = req.params;
    const { scheduledDate, status, timezone } = req.body;
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    const scheduleItem = await storage.getContentScheduleById(scheduleId);
    if (!scheduleItem || scheduleItem.userId !== userId) {
      res.status(404).json({ message: "Scheduled content not found or access denied" });
      return;
    }
    
    const updates: any = {};
    
    // Handle timezone update
    if (timezone !== undefined) {
      updates.timezone = timezone;
    }
    
    // Handle scheduled date update with timezone consideration
    if (scheduledDate !== undefined) {
      const scheduleTime = new Date(scheduledDate);
      const checkTimezone = timezone || scheduleItem.timezone || 'UTC';
      const nowInTimezone = new Date().toLocaleString('en-US', { timeZone: checkTimezone });
      const nowInTimezoneDate = new Date(nowInTimezone);
      
      if (scheduleTime <= nowInTimezoneDate && status !== 'cancelled') {
        res.status(400).json({ 
          message: `Scheduled date must be in the future (current time in ${checkTimezone} is ${nowInTimezone}) unless cancelling` 
        });
        return;
      }
      updates.scheduledDate = scheduleTime;
    }
    
    if (status !== undefined) updates.status = status;
    
    const updatedSchedule = await storage.updateContentSchedule(scheduleId, updates);
    
    await storage.createActivityLog({
      userId,
      websiteId,
      type: "content_schedule_updated",
      description: `Publication schedule updated for content`,
      metadata: { 
        scheduleId,
        updates: Object.keys(updates),
        timezone: updates.timezone || scheduleItem.timezone || 'UTC'
      }
    });
    
    res.json({
      ...updatedSchedule,
      timezone: updatedSchedule.timezone || scheduleItem.timezone || 'UTC'
    });
    
  } catch (error) {
    console.error("Failed to update scheduled content:", error);
    res.status(500).json({ 
      message: "Failed to update scheduled content",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// System endpoint to manually trigger scheduled content publishing
app.post("/api/system/publish-scheduled-content", async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🕐 Manually triggering scheduled content publication...');
    
    // Use the scheduler service's method which handles timezone properly
    const result = await schedulerService.manualProcess();
    
    console.log(`🎯 Manual processing complete: ${result.published} published, ${result.failed} failed`);
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    console.error("Manual scheduled publishing process failed:", error);
    res.status(500).json({ 
      message: "Failed to process scheduled content",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// System endpoint to check what schedules should run now (for debugging)
app.get("/api/system/check-schedules", async (req: Request, res: Response): Promise<void> => {
  try {
    const currentSchedules = await schedulerService.checkCurrentSchedules();
    
    res.json({
      success: true,
      ...currentSchedules,
      message: `Found ${currentSchedules.schedulesToRun.length} schedules that should run now`
    });
    
  } catch (error) {
    console.error("Failed to check current schedules:", error);
    res.status(500).json({ 
      message: "Failed to check schedules",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// System endpoint to manually trigger auto-generation schedules
app.post("/api/system/process-auto-schedules", async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🤖 Manually triggering auto-generation schedules...');
    
    const result = await schedulerService.manualProcessAutoSchedules();
    
    res.json({
      success: true,
      message: "Auto-generation schedules processed",
      result
    });
    
  } catch (error) {
    console.error("Failed to process auto-generation schedules:", error);
    res.status(500).json({ 
      message: "Failed to process auto-generation schedules",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get timezone information for debugging
app.get("/api/system/timezone-info", async (req: Request, res: Response): Promise<void> => {
  try {
    const { timezone = 'UTC' } = req.query;
    
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: timezone as string
    });
    
    const timeInZone = formatter.format(now);
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZoneName: 'short',
      timeZone: timezone as string
    }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value;
    
    res.json({
      timezone,
      currentTime: timeInZone,
      offset,
      serverTime: now.toISOString(),
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    
  } catch (error) {
    res.status(400).json({ 
      message: "Invalid timezone",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post("/api/user/auto-schedules", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { utcTime, name, ...scheduleDataWithoutUtc } = req.body; // Remove utcTime if sent
    
    console.log('API received schedule request:', {
      localTime: scheduleDataWithoutUtc.localTime,
      timezone: scheduleDataWithoutUtc.timezone,
      utcTimeFromClient: utcTime, // Log if client sent it (shouldn't)
    });
    
    // Pass data WITHOUT utcTime to force backend calculation
    const newSchedule = await storage.createAutoSchedule({
      ...scheduleDataWithoutUtc,
      name,
      userId,
      // Explicitly don't include utcTime
    });
    
    res.json(newSchedule);
  } catch (error) {
    console.error("Failed to create auto-schedule:", error);
    res.status(500).json({ 
      message: "Failed to create schedule",
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});


// SIMPLE UTC CONVERSION FUNCTION
function convertLocalTimeToUTC(localTime: string, timezone: string): string {
  const [hours, minutes] = localTime.split(':').map(Number);
  
  // Timezone offset map (in hours ahead of UTC)
  const timezoneOffsets: Record<string, number> = {
    'Asia/Tokyo': 9,        // Japan
    'Asia/Manila': 8,       // Philippines  
    'Asia/Shanghai': 8,     // China
    'Asia/Singapore': 8,    // Singapore
    'Asia/Hong_Kong': 8,    // Hong Kong
    'Asia/Taipei': 8,       // Taiwan
    'Asia/Seoul': 9,        // South Korea
    'Asia/Jakarta': 7,      // Indonesia (West)
    'Asia/Bangkok': 7,      // Thailand
    'Asia/Ho_Chi_Minh': 7,  // Vietnam
    'Asia/Kolkata': 5.5,    // India
    'Asia/Dubai': 4,        // UAE
    'Europe/London': 0,     // UK (GMT, varies with DST)
    'Europe/Paris': 1,      // France (CET, varies with DST)
    'America/New_York': -5, // US East Coast (EST, varies with DST)
    'America/Los_Angeles': -8, // US West Coast (PST, varies with DST)
    'UTC': 0,
  };
  
  const offset = timezoneOffsets[timezone] ?? 0;
  
  // Convert to UTC by subtracting the offset
  let utcHours = hours - offset;
  let utcMinutes = minutes - Math.floor((offset % 1) * 60); // Handle half-hour offsets like India
  
  // Handle minute overflow/underflow
  if (utcMinutes < 0) {
    utcMinutes += 60;
    utcHours -= 1;
  } else if (utcMinutes >= 60) {
    utcMinutes -= 60;
    utcHours += 1;
  }
  
  // Handle hour overflow/underflow (day boundaries)
  if (utcHours < 0) {
    utcHours += 24; // Previous day in UTC
  } else if (utcHours >= 24) {
    utcHours -= 24; // Next day in UTC
  }
  
  const result = `${String(Math.floor(utcHours)).padStart(2, '0')}:${String(utcMinutes).padStart(2, '0')}`;
  
  console.log(`⏰ Timezone conversion: ${localTime} ${timezone} (UTC+${offset}) → ${result} UTC`);
  
  return result;
}

// ==========================================
// AUTO-SCHEDULE API ENDPOINTS
// ==========================================

// GET all auto-schedules for a user (optionally filtered by website)
app.get("/api/user/auto-schedules", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId } = req.query;
    
    console.log('📋 Fetching auto-schedules for user:', userId, websiteId ? `website: ${websiteId}` : '');
    
    let schedules;
    if (websiteId) {
      // Verify user has access to this website
      const website = await storage.getUserWebsite(websiteId as string, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      schedules = await storage.getAutoSchedulesByWebsite(websiteId as string);
    } else {
      schedules = await storage.getUserAutoSchedules(userId);
    }
    
    console.log(`✅ Found ${schedules.length} schedules`);
    res.json({ schedules });
  } catch (error) {
    console.error("Failed to fetch auto-schedules:", error);
    res.status(500).json({ 
      message: "Failed to fetch schedules",
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});

// UPDATE an auto-schedule
app.put("/api/user/auto-schedules/:scheduleId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { scheduleId } = req.params;
    const { utcTime, ...updateDataWithoutUtc } = req.body;
    
    console.log('🔄 Updating auto-schedule:', scheduleId);
    
    // Verify ownership
    const existingSchedule = await storage.getAutoSchedule(scheduleId);
    if (!existingSchedule || existingSchedule.userId !== userId) {
      res.status(404).json({ message: "Schedule not found or access denied" });
      return;
    }
    
    // If localTime or timezone is being updated, recalculate UTC time
    let finalUpdateData = { ...updateDataWithoutUtc };
    if (updateDataWithoutUtc.localTime || updateDataWithoutUtc.timezone) {
      const localTime = updateDataWithoutUtc.localTime || existingSchedule.localTime;
      const timezone = updateDataWithoutUtc.timezone || existingSchedule.timezone;
      
      if (localTime && timezone) {
        const calculatedUtcTime = convertLocalTimeToUTC(localTime, timezone);
        finalUpdateData.utcTime = calculatedUtcTime;
        console.log(`✅ Recalculated UTC time: ${localTime} ${timezone} → ${calculatedUtcTime} UTC`);
      }
    }
    
    await storage.updateAutoSchedule(scheduleId, finalUpdateData);
    const updatedSchedule = await storage.getAutoSchedule(scheduleId);
    
    await storage.createActivityLog({
      userId,
      websiteId: existingSchedule.websiteId,
      type: "auto_schedule_updated",
      description: `Auto-generation schedule updated: ${existingSchedule.name}`,
      metadata: { scheduleId, updates: Object.keys(finalUpdateData) }
    });
    
    console.log('✅ Schedule updated successfully');
    res.json(updatedSchedule);
  } catch (error) {
    console.error("Failed to update auto-schedule:", error);
    res.status(500).json({ 
      message: "Failed to update schedule",
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});

// DELETE an auto-schedule
app.delete("/api/user/auto-schedules/:scheduleId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { scheduleId } = req.params;
    
    console.log('🗑️ Deleting auto-schedule:', scheduleId);
    
    // Verify ownership
    const existingSchedule = await storage.getAutoSchedule(scheduleId);
    if (!existingSchedule || existingSchedule.userId !== userId) {
      res.status(404).json({ message: "Schedule not found or access denied" });
      return;
    }
    
    const success = await storage.deleteAutoSchedule(scheduleId);
    
    if (success) {
      await storage.createActivityLog({
        userId,
        websiteId: existingSchedule.websiteId,
        type: "auto_schedule_deleted",
        description: `Auto-generation schedule deleted: ${existingSchedule.name}`,
        metadata: { scheduleId }
      });
      
      console.log('✅ Schedule deleted successfully');
      res.json({ message: "Schedule deleted successfully" });
    } else {
      res.status(500).json({ message: "Failed to delete schedule" });
    }
  } catch (error) {
    console.error("Failed to delete auto-schedule:", error);
    res.status(500).json({ 
      message: "Failed to delete schedule",
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});

// TOGGLE schedule active status
app.post("/api/user/auto-schedules/:scheduleId/toggle", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { scheduleId } = req.params;
    const { isActive } = req.body;
    
    console.log('🔀 Toggling auto-schedule:', scheduleId, 'to', isActive);
    
    // Verify ownership
    const existingSchedule = await storage.getAutoSchedule(scheduleId);
    if (!existingSchedule || existingSchedule.userId !== userId) {
      res.status(404).json({ message: "Schedule not found or access denied" });
      return;
    }
    
    const updatedSchedule = await storage.toggleAutoSchedule(scheduleId, isActive);
    
    await storage.createActivityLog({
      userId,
      websiteId: existingSchedule.websiteId,
      type: isActive ? "auto_schedule_activated" : "auto_schedule_paused",
      description: `Auto-generation schedule ${isActive ? 'activated' : 'paused'}: ${existingSchedule.name}`,
      metadata: { scheduleId }
    });
    
    console.log('✅ Schedule toggled successfully');
    res.json(updatedSchedule);
  } catch (error) {
    console.error("Failed to toggle auto-schedule:", error);
    res.status(500).json({ 
      message: "Failed to toggle schedule",
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});

// MANUALLY RUN a schedule now
app.post("/api/user/auto-schedules/:scheduleId/run", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { scheduleId } = req.params;
    
    console.log('▶️ Manually running auto-schedule:', scheduleId);
    
    // Verify ownership
    const schedule = await storage.getAutoSchedule(scheduleId);
    if (!schedule || schedule.userId !== userId) {
      res.status(404).json({ message: "Schedule not found or access denied" });
      return;
    }
    
    // Trigger the schedule manually using your scheduler service
    const result = await schedulerService.runScheduleManually(scheduleId);
    
    await storage.createActivityLog({
      userId,
      websiteId: schedule.websiteId,
      type: "auto_schedule_manual_run",
      description: `Manually triggered auto-generation: ${schedule.name}`,
      metadata: { scheduleId, result }
    });
    
    console.log('✅ Schedule triggered successfully');
    res.json({ 
      message: "Schedule triggered successfully",
      result 
    });
  } catch (error) {
    console.error("Failed to run auto-schedule:", error);
    res.status(500).json({ 
      message: "Failed to run schedule",
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});






  // ===========================================================================
  // SEO ANALYSIS & TRACKING ROUTES
  // ===========================================================================
  
 app.get("/api/user/websites/:id/seo-reports", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const website = await storage.getUserWebsite(req.params.id, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    // Fix: Pass userId as second parameter
    const reports = await storage.getSeoReportsByWebsite(req.params.id, userId);
    res.json(reports);
  } catch (error) {
    console.error("Failed to fetch SEO reports:", error);
    res.status(500).json({ message: "Failed to fetch SEO reports" });
  }
});

  app.post("/api/user/websites/:id/seo-analysis", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;
    const { 
      targetKeywords, 
      crawlEnabled, 
      maxCrawlPages, 
      crawlDepth,
      runLighthouse,
      usePuppeteer,
      deepWordPressAnalysis
    } = req.body;
    
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }

    console.log(`🔍 Starting SEO analysis for website: ${website.name} (${website.url})`);

    const analysis = await seoService.analyzeWebsite(
      website.url, 
      targetKeywords || [],
      userId,
      websiteId,
      {
        crawlEnabled: true,
        maxCrawlPages: maxCrawlPages ?? 50,
        crawlDepth: crawlDepth ?? 3,
        runLighthouse: runLighthouse ?? true,
        usePuppeteer: usePuppeteer ?? true,
        deepWordPressAnalysis: deepWordPressAnalysis ?? true,
      }
    );
    
    console.log(`✅ SEO analysis completed. Score: ${analysis.score}, Issues: ${analysis.issues.length}`);
    
    // Add crawl info to response if available
    if (analysis.crawlSummary) {
      console.log(`🕷️ Crawled ${analysis.crawlSummary.totalPagesAnalyzed} pages, ${analysis.crawlSummary.pagesWithIssues} with issues`);
    }

    res.json(analysis);
  } catch (error) {
    console.error("SEO analysis error:", error);
    
    let statusCode = 500;
    let errorMessage = error instanceof Error ? error.message : "Failed to perform SEO analysis";
    
    if (error instanceof Error) {
      if (error.message.includes('Cannot access website')) {
        statusCode = 400;
        errorMessage = `Website is not accessible: ${error.message}`;
      } else if (error.message.includes('timeout')) {
        statusCode = 408;
        errorMessage = "Website took too long to respond. Please try again.";
      }
    }
    
    res.status(statusCode).json({ 
      message: errorMessage,
      error: 'SEO_ANALYSIS_FAILED'
    });
  }
});


  app.get("/api/user/websites/:websiteId/detailed-seo", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { websiteId } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      console.log(`Getting detailed SEO data for website ${websiteId}`);

      const detailedData = await seoService.getDetailedSeoData(websiteId, userId);

      res.json(detailedData);
    } catch (error) {
      console.error("Error getting detailed SEO data:", error);
      res.status(500).json({ 
        message: "Failed to get detailed SEO data",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/user/websites/:websiteId/tracked-issues", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { websiteId } = req.params;
      const userId = req.user?.id;
      const { status, autoFixableOnly, limit } = req.query;

      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      const options: any = {};
      
      if (status && typeof status === 'string') {
        options.status = status.split(',');
      }
      
      if (autoFixableOnly === 'true') {
        options.autoFixableOnly = true;
      }
      
      if (limit && !isNaN(Number(limit))) {
        options.limit = Number(limit);
      }

      const trackedIssues = await storage.getTrackedSeoIssues(websiteId, userId, options);

      res.json(trackedIssues);
    } catch (error) {
      console.error("Error getting tracked issues:", error);
      res.status(500).json({ 
        message: "Failed to get tracked issues",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/user/websites/:websiteId/issue-summary", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { websiteId } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      const summary = await storage.getSeoIssueTrackingSummary(websiteId, userId);

      res.json(summary);
    } catch (error) {
      console.error("Error getting issue summary:", error);
      res.status(500).json({ 
        message: "Failed to get issue summary",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.put("/api/user/tracked-issues/:issueId/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { issueId } = req.params;
      const { status, resolutionNotes, fixMethod } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const trackedIssues = await storage.getTrackedSeoIssues("", userId, { limit: 1000 });
      const issue = trackedIssues.find(i => i.id === issueId);
      
      if (!issue) {
        res.status(404).json({ message: "Issue not found or access denied" });
        return;
      }

      const website = await storage.getUserWebsite(issue.websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      const validStatuses = ['detected', 'fixing', 'fixed', 'resolved', 'reappeared'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ message: "Invalid status" });
        return;
      }

      const updatedIssue = await storage.updateSeoIssueStatus(issueId, status, {
        fixMethod: fixMethod || 'manual',
        resolutionNotes
      });

      if (!updatedIssue) {
        res.status(404).json({ message: "Issue not found" });
        return;
      }

      res.json(updatedIssue);
    } catch (error) {
      console.error("Error updating issue status:", error);
      res.status(500).json({ 
        message: "Failed to update issue status",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });


  app.delete("/api/user/websites/:id/seo-reports", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;
    
    // Verify ownership
    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }
    
    console.log(`🗑️ Clearing SEO history (keeping latest) for website: ${website.name} (${websiteId})`);
    
    // Use the clearAllSeoData method which keeps the latest report
    const result = await storage.clearAllSeoData(websiteId, userId);
    
    // Log the activity with details
    await storage.createActivityLog({
      userId,
      websiteId,
      type: "seo_history_cleared",
      description: `SEO history cleared for ${website.name} (kept latest report)`,
      metadata: { 
        deletedReports: result.deletedReports,
        deletedIssues: result.deletedIssues,
        keptLatestReport: result.keptLatestReport,
        preservedIssues: result.preservedIssues,
        clearedAt: new Date().toISOString()
      }
    });
    
    console.log(`✅ SEO history cleared: deleted ${result.deletedReports} reports, ${result.deletedIssues} issues, kept latest report`);
    
    // Return the result so the frontend knows what happened
    res.status(200).json({
      success: true,
      message: `Cleared ${result.deletedReports} old reports and ${result.deletedIssues} issues. Latest report preserved.`,
      ...result
    });
  } catch (error) {
    console.error("Failed to clear SEO history:", error);
    res.status(500).json({ 
      message: "Failed to clear SEO history",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

  // ===========================================================================
  // AI FIX ROUTES
  // ===========================================================================
  
  app.post("/api/user/websites/:id/ai-fix", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;
    const { 
      dryRun = true, 
      fixTypes, 
      maxChanges, 
      skipBackup,
      enableReanalysis = true, // NEW: Enable by default
      reanalysisDelay,         // NEW: Optional custom delay in ms
      forceReanalysis = false, // NEW: Force immediate reanalysis (for testing)
      processingMode,          // NEW: Optional processing mode
      processingOptions        // NEW: Optional processing options
    } = req.body;

    console.log(`AI fix request for website ${websiteId} (dry run: ${dryRun}, reanalysis: ${enableReanalysis}, force: ${forceReanalysis})`);

    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }

    const result = await aiFixService.analyzeAndFixWebsite(
      websiteId,
      userId,
      dryRun,
      { 
        fixTypes, 
        maxChanges, 
        skipBackup,
        enableReanalysis,
        reanalysisDelay,
        forceReanalysis,
        processingMode,
        processingOptions
      }
    );

    console.log(`AI fix completed. Success: ${result.success}, Applied: ${result.stats.fixesSuccessful} fixes`);

    // Build response
    const response: any = {
      success: result.success,
      message: result.message,
      dryRun: result.dryRun,
      stats: result.stats,
      applied: {
        imagesAltUpdated: result.fixesApplied.filter(f => f.type === 'missing_alt_text' && f.success).length,
        metaDescriptionUpdated: result.fixesApplied.some(f => f.type === 'missing_meta_description' && f.success),
        titleTagsUpdated: result.fixesApplied.filter(f => f.type === 'poor_title_tag' && f.success).length,
        headingStructureFixed: result.fixesApplied.some(f => f.type === 'heading_structure' && f.success),
        contentExpanded: result.fixesApplied.some(f => f.type === 'thin_content' && f.success),
        schemaAdded: result.fixesApplied.some(f => f.type === 'missing_schema' && f.success),
      },
      fixes: result.fixesApplied,
      errors: result.errors,
      estimatedImpact: result.stats.estimatedImpact,
      fixSessionId: result.fixSessionId
    };

    // NEW: Include reanalysis data if available
    if (result.reanalysis) {
      response.reanalysis = {
        enabled: result.reanalysis.enabled,
        success: result.reanalysis.success,
        initialScore: result.reanalysis.initialScore,
        finalScore: result.reanalysis.finalScore,
        scoreImprovement: result.reanalysis.scoreImprovement,
        analysisTime: result.reanalysis.analysisTime,
        simulated: result.reanalysis.simulated,
        error: result.reanalysis.error
      };
    }

    // NEW: Add detailed log if fixes were applied
    if (!dryRun && result.fixesApplied.length > 0) {
      response.detailedLog = result.detailedLog;
    }

    res.json(response);

  } catch (error) {
    console.error("AI fix error:", error);
    
    let statusCode = 500;
    let errorMessage = "Failed to apply AI fixes";
    
    if (error instanceof Error) {
      errorMessage = error.message;
      if (error.message.includes('No SEO analysis found')) {
        statusCode = 400;
        errorMessage = "Please run SEO analysis first before applying AI fixes";
      } else if (error.message.includes('access denied')) {
        statusCode = 403;
      } else if (error.message.includes('Cannot access website')) {
        statusCode = 400;
        errorMessage = "Cannot access website for analysis. Please check if the website is online and accessible.";
      } else if (error.message.includes('WordPress credentials not configured')) {
        statusCode = 400;
        errorMessage = "WordPress credentials not configured. Please add your WordPress application password in website settings.";
      } else if (error.message.includes('WordPress connection failed')) {
        statusCode = 400;
        errorMessage = "Could not connect to WordPress. Please verify your credentials and ensure the site is accessible.";
      }
    }
    
    res.status(statusCode).json({ 
      success: false,
      message: errorMessage,
      error: error instanceof Error ? error.name : 'AIFixError'
    });
  }
});

// NEW: Endpoint to check scheduled reanalysis status
app.get("/api/user/websites/:id/scheduled-reanalysis", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;

    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }

    const scheduledTasks = await storage.getScheduledTasks(websiteId, userId, {
      type: 'seo_reanalysis',
      status: 'pending'
    });

    res.json({
      success: true,
      hasScheduledReanalysis: scheduledTasks.length > 0,
      scheduledTasks: scheduledTasks.map(task => ({
        id: task.id,
        scheduledFor: task.scheduledFor,
        createdAt: task.createdAt,
        metadata: task.metadata
      }))
    });

  } catch (error) {
    console.error("Error fetching scheduled tasks:", error);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch scheduled reanalysis"
    });
  }
});

// NEW: Endpoint to manually trigger scheduled reanalysis
app.post("/api/user/websites/:id/run-scheduled-reanalysis", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.params.id;

    const website = await storage.getUserWebsite(websiteId, userId);
    if (!website) {
      res.status(404).json({ message: "Website not found or access denied" });
      return;
    }

    console.log(`Running scheduled reanalysis for website ${websiteId}`);

    // Run the reanalysis
    const analysis = await seoService.analyzeWebsite(
      website.url,
      [],
      userId,
      websiteId,
      {
        skipIssueTracking: false, // Track issues now
        usePuppeteer: true,
        runLighthouse: true,
        crawlEnabled: true,
        maxCrawlPages: 50,
      }
    );

    // Mark scheduled tasks as completed
    await storage.updateScheduledTasksStatus(websiteId, userId, 'seo_reanalysis', 'completed');

    res.json({
      success: true,
      message: "Reanalysis completed successfully",
      score: analysis.score,
      issues: analysis.issues.length,
      recommendations: analysis.recommendations.length
    });

  } catch (error) {
    console.error("Error running scheduled reanalysis:", error);
    res.status(500).json({ 
      success: false,
      message: "Failed to run scheduled reanalysis"
    });
  }
});

  app.post("/api/user/websites/:id/iterative-ai-fix", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const websiteId = req.params.id;
      const { 
        targetScore = 85, 
        maxIterations = 5, 
        minImprovementThreshold = 2,
        fixTypes, 
        maxChangesPerIteration = 20, 
        skipBackup = false 
      } = req.body;

      console.log(`🔄 Starting iterative AI fix for website ${websiteId} (target: ${targetScore}, max iterations: ${maxIterations})`);

      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      if (targetScore < 50 || targetScore > 100) {
        res.status(400).json({ 
          message: "Target score must be between 50 and 100",
          error: "INVALID_TARGET_SCORE"
        });
        return;
      }

      if (maxIterations < 1 || maxIterations > 10) {
        res.status(400).json({ 
          message: "Max iterations must be between 1 and 10",
          error: "INVALID_MAX_ITERATIONS"
        });
        return;
      }

      const result = await aiFixService.iterativelyFixUntilAcceptable(
        websiteId,
        userId,
        { 
          targetScore, 
          maxIterations, 
          minImprovementThreshold,
          fixTypes, 
          maxChangesPerIteration,
          skipBackup 
        }
      );

      console.log(`✅ Iterative AI fix completed. Final score: ${result.finalScore}, Iterations: ${result.iterationsCompleted}`);

      res.json({
        success: result.success,
        message: result.message,
        iterative: true,
        
        initialScore: result.initialScore,
        finalScore: result.finalScore,
        scoreImprovement: result.scoreImprovement,
        targetScore: result.targetScore,
        targetReached: result.finalScore >= result.targetScore,
        
        iterationsCompleted: result.iterationsCompleted,
        stoppedReason: result.stoppedReason,
        maxIterations,
        
        iterations: result.iterations.map(iter => ({
          iteration: iter.iterationNumber,
          scoreBefore: iter.scoreBefore,
          scoreAfter: iter.scoreAfter,
          improvement: iter.improvement,
          fixesApplied: iter.fixesSuccessful,
          duration: `${iter.fixTime + iter.analysisTime}s`,
          timestamp: iter.timestamp
        })),
        
        stats: {
          ...result.stats,
          scoreProgressionPercentage: result.initialScore > 0 
            ? Math.round((result.scoreImprovement / result.initialScore) * 100) 
            : 0,
          averageImprovementPerIteration: result.iterationsCompleted > 0 
            ? result.scoreImprovement / result.iterationsCompleted 
            : 0,
          totalProcessingTime: result.iterations.reduce((total, iter) => 
            total + iter.fixTime + iter.analysisTime, 0
          )
        },
        
        applied: {
          totalFixesApplied: result.fixesApplied.filter(f => f.success).length,
          imagesAltUpdated: result.fixesApplied.filter(f => f.type === 'missing_alt_text' && f.success).length,
          metaDescriptionsUpdated: result.fixesApplied.filter(f => f.type === 'missing_meta_description' && f.success).length,
          titleTagsUpdated: result.fixesApplied.filter(f => f.type === 'poor_title_tag' && f.success).length,
          headingStructureFixed: result.fixesApplied.filter(f => f.type === 'heading_structure' && f.success).length
        },
        
        fixes: result.fixesApplied,
        errors: result.errors,
        detailedLog: result.detailedLog,
        
        recommendations: generateIterativeFixRecommendations(result)
      });

    } catch (error) {
      console.error("Iterative AI fix error:", error);
      
      let statusCode = 500;
      let errorMessage = "Failed to complete iterative AI fixes";
      
      if (error instanceof Error) {
        errorMessage = error.message;
        if (error.message.includes('No SEO analysis found')) {
          statusCode = 400;
          errorMessage = "Please run SEO analysis first before applying iterative AI fixes";
        } else if (error.message.includes('access denied')) {
          statusCode = 403;
        } else if (error.message.includes('Cannot access website')) {
          statusCode = 400;
          errorMessage = "Cannot access website for analysis. Please check if the website is online and accessible.";
        }
      }
      
      res.status(statusCode).json({ 
        success: false,
        message: errorMessage,
        iterative: true,
        error: error instanceof Error ? error.name : 'IterativeAIFixError'
      });
    }
  });

  app.get("/api/user/websites/:id/available-fixes", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const websiteId = req.params.id;

      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      const availableFixes = await aiFixService.getAvailableFixTypes(websiteId, userId);

      res.json({
        websiteId,
        websiteName: website.name,
        websiteUrl: website.url,
        ...availableFixes,
        fixTypes: {
          'missing_alt_text': 'Add missing alt text to images',
          'missing_meta_description': 'Optimize meta descriptions',
          'poor_title_tag': 'Improve title tags',
          'heading_structure': 'Fix heading hierarchy',
          'internal_linking': 'Add internal links',
          'image_optimization': 'Optimize images for SEO'
        }
      });

    } catch (error) {
      console.error("Get available fixes error:", error);
      res.status(500).json({ 
        message: "Failed to get available fixes",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.get("/api/user/websites/:id/ai-fix-history", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const websiteId = req.params.id;

      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }

      const logs = await storage.getUserActivityLogs(userId, websiteId);
      const aiFixLogs = logs.filter(log => 
        log.type === 'ai_fixes_applied' || 
        log.type === 'ai_fix_attempted' ||
        log.type === 'ai_fix_failed'
      );

      res.json({
        websiteId,
        history: aiFixLogs.map(log => ({
          id: log.id,
          date: log.createdAt,
          type: log.type,
          description: log.description,
          metadata: log.metadata,
          success: log.type === 'ai_fixes_applied'
        }))
      });

    } catch (error) {
      console.error("Get AI fix history error:", error);
      res.status(500).json({ 
        message: "Failed to get AI fix history",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ===========================================================================
  // CLIENT REPORTS ROUTES
  // ===========================================================================
  
  app.get("/api/user/reports", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      console.log(`📊 Fetching all reports for user: ${userId}`);
      
      const websites = await storage.getUserWebsites(userId);
      const allReports = [];
      
      for (const website of websites) {
        const reports = await storage.getClientReports(website.id);
        const reportsWithWebsite = reports.map(report => ({
          ...report,
          websiteName: website.name,
          websiteUrl: website.url
        }));
        allReports.push(...reportsWithWebsite);
      }
      
      allReports.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
      
      console.log(`✅ Found ${allReports.length} reports for user ${userId}`);
      res.json(allReports);
    } catch (error) {
      console.error("Failed to fetch user reports:", error);
      res.status(500).json({ message: "Failed to fetch reports" });
    }
  });

  app.get("/api/user/websites/:id/reports", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const websiteId = req.params.id;
      
      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      
      const reports = await storage.getClientReports(websiteId);
      const reportsWithWebsite = reports.map(report => ({
        ...report,
        websiteName: website.name,
        websiteUrl: website.url
      }));
      
      res.json(reportsWithWebsite);
    } catch (error) {
      console.error("Failed to fetch client reports:", error);
      res.status(500).json({ message: "Failed to fetch client reports" });
    }
  });

  app.post("/api/user/websites/:id/reports/generate", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const websiteId = req.params.id;
      const { reportType = 'monthly' } = req.body;
      
      console.log(`🔄 Generating ${reportType} report for website: ${websiteId}, user: ${userId}`);
      
      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ message: "Website not found or access denied" });
        return;
      }
      
      const now = new Date();
      let targetPeriod: string;
      
      if (reportType === 'weekly') {
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const days = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
        const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
        targetPeriod = `Week ${weekNumber}, ${now.getFullYear()}`;
      } else if (reportType === 'monthly') {
        targetPeriod = `${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
      } else {
        const quarter = Math.floor(now.getMonth() / 3) + 1;
        targetPeriod = `Q${quarter} ${now.getFullYear()}`;
      }
      
      const existingReports = await storage.getClientReports(websiteId);
      const existingReport = existingReports.find(report => 
        report.reportType === reportType && report.period === targetPeriod
      );
      
      if (existingReport) {
        console.log(`⚠️ Report already exists for ${targetPeriod}, ${reportType}. Updating existing report.`);
        
        const reportData = await generateReportData(websiteId, reportType, userId);
        
        const updatedReport = await storage.updateClientReport(existingReport.id, {
          data: reportData.data,
          insights: reportData.insights,
          roiData: reportData.roiData,
          generatedAt: new Date()
        });
        
        console.log(`✅ Report updated successfully: ${updatedReport.id}`);
        
        await storage.createActivityLog({
          userId,
          websiteId,
          type: "report_updated",
          description: `${reportType} report updated for ${website.name} (${targetPeriod})`,
          metadata: { reportId: updatedReport.id, reportType, period: targetPeriod, action: 'update' }
        });
        
        res.json({
          ...updatedReport,
          websiteName: website.name,
          websiteUrl: website.url,
          updated: true,
          message: `Updated existing ${reportType} report for ${targetPeriod}`
        });
        return;
      }
      
      const reportData = await generateReportData(websiteId, reportType, userId);
      
      const report = await storage.createClientReport({
        userId,
        websiteId,
        reportType,
        period: reportData.period,
        data: reportData.data,
        insights: reportData.insights,
        roiData: reportData.roiData
      });
      
      console.log(`✅ New report generated successfully: ${report.id}`);
      
      await storage.createActivityLog({
        userId,
        websiteId,
        type: "report_generated",
        description: `${reportType} report generated for ${website.name} (${reportData.period})`,
        metadata: { reportId: report.id, reportType, period: reportData.period, action: 'create' }
      });
      
      res.json({
        ...report,
        websiteName: website.name,
        websiteUrl: website.url,
        updated: false,
        message: `Generated new ${reportType} report for ${reportData.period}`
      });
      
    } catch (error) {
      console.error("Report generation error:", error);
      res.status(500).json({ 
        message: "Failed to generate report",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });


// ======================================================================
// BULK DELETE MUST COME FIRST - BEFORE THE :id ROUTE
// ======================================================================
app.delete("/api/user/reports/bulk-delete", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { reportIds } = req.body;
    
    console.log(`🗑️ Bulk DELETE request for ${reportIds?.length || 0} reports from user: ${userId}`);
    
    // Validate input
    if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Invalid request: reportIds array is required'
      });
      return;
    }
    
    // Your bulk delete logic here...
    const reports = await storage.getReportsByIds(reportIds, userId);
    const foundReportIds = reports.map((r: any) => r.id);
    const notFoundIds = reportIds.filter(id => !foundReportIds.includes(id));

    if (foundReportIds.length === 0) {
      res.status(404).json({
        success: false,
        message: 'No reports found or authorized for deletion',
        notFoundIds
      });
      return;
    }

    const deleteCount = await storage.bulkDeleteReports(foundReportIds, userId);

    res.status(200).json({
      success: true,
      message: `Successfully deleted ${deleteCount} report(s)`,
      deleted: deleteCount,
      deletedIds: foundReportIds,
      notFoundIds: notFoundIds.length > 0 ? notFoundIds : undefined
    });

  } catch (error) {
    console.error("Failed to bulk delete reports:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete reports",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ======================================================================
// SINGLE DELETE COMES SECOND - AFTER BULK-DELETE
// ======================================================================
app.delete("/api/user/reports/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const reportId = req.params.id;
    
    console.log(`🗑️ DELETE request for report ${reportId} from user: ${userId}`);
    
    // Your single delete logic here...
    const report = await storage.getReportById(reportId, userId);
    
    if (!report) {
      console.log(`❌ Report ${reportId} not found or unauthorized for user ${userId}`);
      res.status(404).json({
        success: false,
        message: 'Report not found or access denied'
      });
      return;
    }

    const success = await storage.deleteReport(reportId, userId);
    
    if (success) {
      res.status(204).send();
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to delete report'
      });
    }

  } catch (error) {
    console.error("Failed to delete report:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete report",
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});



  // ===========================================================================
  // IMAGE MANAGEMENT & BATCH PROCESSING ROUTES  
  // ===========================================================================
  
  app.get("/api/images/content-images", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const { websiteId } = req.query;
      
      console.log('🖼️ Fetching images for user:', userId);
      console.log('Website ID:', websiteId || 'all');
      
      const images: any[] = [];
      
      const websites = await storage.getUserWebsites(userId);
      
      const websitesToProcess = websiteId && websiteId !== 'undefined' 
        ? websites.filter(w => w.id === websiteId)
        : websites;
      
      console.log(`Processing ${websitesToProcess.length} websites`);
      
      for (const website of websitesToProcess) {
        console.log(`\n📌 Processing: ${website.name}`);
        console.log(`URL: ${website.url}`);
        
        if (!website.url) {
          console.log('No URL configured, skipping');
          continue;
        }
        
        const baseUrl = website.url.replace(/\/$/, '');
        
        let decryptedPassword = website.wpApplicationPassword;
        
        try {
          const postsUrl = `${baseUrl}/wp-json/wp/v2/posts?_embed&per_page=100`;
          console.log(`Fetching posts from: ${postsUrl}`);
          
          const headers: any = { 
            'Content-Type': 'application/json',
            'User-Agent': 'WordPress-Image-Manager/1.0'
          };
          
          if (decryptedPassword) {
            const username = website.wpUsername || website.wpApplicationName || 'admin';
            const authString = `${username}:${decryptedPassword}`;
            headers['Authorization'] = `Basic ${Buffer.from(authString).toString('base64')}`;
            console.log(`Using auth for: ${username}`);
          }
          
          const postsResponse = await fetch(postsUrl, { headers });
          console.log(`Response status: ${postsResponse.status}`);
          
          if (postsResponse.ok) {
            const posts = await postsResponse.json();
            console.log(`✅ Found ${posts.length} posts`);
            
            for (const post of posts) {
              const postTitle = post.title?.rendered?.replace(/<[^>]*>/g, '').trim() || 'Untitled';
              
              if (post._embedded?.['wp:featuredmedia']?.[0]) {
                const media = post._embedded['wp:featuredmedia'][0];
                if (media.media_type === 'image' && media.source_url) {
                  images.push({
                    id: `wp_${website.id}_${post.id}_featured`,
                    url: media.source_url,
                    contentId: `post_${post.id}`,
                    contentTitle: postTitle,
                    websiteId: website.id,
                    websiteName: website.name,
                    hasMetadata: !!(media.alt_text || media.caption?.rendered),
                    metadataDetails: {
                      altText: media.alt_text || '',
                      caption: media.caption?.rendered?.replace(/<[^>]*>/g, '') || '',
                      isFeatured: true
                    },
                    size: media.media_details?.filesize || 0,
                    createdAt: post.date,
                    isAIGenerated: false,
                    processedAt: post.modified,
                    costCents: 0
                  });
                }
              }
              
              if (post.content?.rendered) {
                const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
                let match;
                
                while ((match = imgRegex.exec(post.content.rendered)) !== null) {
                  const url = match[1];
                  
                  if (url.startsWith('data:') || 
                      url.includes('emoji') || 
                      images.some(img => img.url === url)) {
                    continue;
                  }
                  
                  const altMatch = match[0].match(/alt=["']([^"']*?)["']/i);
                  
                  images.push({
                    id: `wp_${website.id}_${post.id}_${images.length}`,
                    url: url,
                    contentId: `post_${post.id}`,
                    contentTitle: postTitle,
                    websiteId: website.id,
                    websiteName: website.name,
                    hasMetadata: !!altMatch,
                    metadataDetails: {
                      altText: altMatch ? altMatch[1] : ''
                    },
                    size: 0,
                    createdAt: post.date,
                    isAIGenerated: false,
                    processedAt: post.modified,
                    costCents: 0
                  });
                }
              }
            }
          } else if (postsResponse.status === 401) {
            console.log('⚠️ Auth failed, trying public access...');
            
            const publicResponse = await fetch(postsUrl);
            if (publicResponse.ok) {
              const posts = await publicResponse.json();
              console.log(`✅ Found ${posts.length} public posts`);
            }
          }
        } catch (error: any) {
          console.error('❌ Error fetching posts:', error.message);
        }
        
        try {
          const mediaUrl = `${baseUrl}/wp-json/wp/v2/media?per_page=100`;
          console.log(`Fetching media from: ${mediaUrl}`);
          
          const mediaResponse = await fetch(mediaUrl);
          
          if (mediaResponse.ok) {
            const mediaItems = await mediaResponse.json();
            console.log(`✅ Found ${mediaItems.length} media items`);
            
            for (const media of mediaItems) {
              if (media.mime_type?.startsWith('image/') && media.source_url) {
                if (!images.some(img => img.url === media.source_url)) {
                  images.push({
                    id: `media_${website.id}_${media.id}`,
                    url: media.source_url,
                    contentId: `media_${media.id}`,
                    contentTitle: media.title?.rendered?.replace(/<[^>]*>/g, '') || 'Media',
                    websiteId: website.id,
                    websiteName: website.name,
                    hasMetadata: !!(media.alt_text || media.caption?.rendered),
                    metadataDetails: {
                      altText: media.alt_text || '',
                      caption: media.caption?.rendered?.replace(/<[^>]*>/g, '') || ''
                    },
                    size: media.media_details?.filesize || 0,
                    createdAt: media.date,
                    isAIGenerated: false,
                    processedAt: media.modified,
                    costCents: 0
                  });
                }
              }
            }
          }
        } catch (error: any) {
          console.error('❌ Error fetching media:', error.message);
        }
      }
      
      console.log(`\n📊 Total images found: ${images.length}`);
      res.json(images);
      
    } catch (error: any) {
      console.error("❌ Failed to fetch images:", error);
      res.status(500).json({ 
        error: 'Failed to fetch images',
        message: error.message 
      });
    }
  });


app.post("/api/images/batch-process", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { imageIds, options, imageUrls } = req.body;
    
    console.log(`🔄 Batch processing ${imageIds.length} images for user ${userId}`);
    console.log('Processing options:', options);
    console.log('Image URLs provided:', Object.keys(imageUrls || {}).length);
    
    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
      res.status(400).json({ 
        error: 'Invalid request',
        message: 'No images selected' 
      });
      return;
    }
    
    if (!options || !options.action) {
      res.status(400).json({ 
        error: 'Invalid request',
        message: 'Processing options required' 
      });
      return;
    }
    
    const results = {
      success: [] as any[],
      failed: [] as string[],
      errors: [] as any[]
    };
    
    const websites = await storage.getUserWebsites(userId);
    const websiteMap = new Map(websites.map(w => [w.id, w]));
    
    for (const imageId of imageIds) {
      const startTime = Date.now();
      
      try {
        console.log(`Processing image: ${imageId}`);
        
        const parts = imageId.split('_');
        
        // Handle crawled images
        if (parts[0] === 'crawled' || imageId.startsWith('crawled')) {
          console.log(`  Processing crawled image: ${imageId}`);
          
          const imageUrl = imageUrls?.[imageId];
          
          if (!imageUrl) {
            throw new Error(`No URL provided for crawled image: ${imageId}`);
          }
          
          console.log(`  Downloading crawled image from: ${imageUrl}`);
          
          try {
            const imageResponse = await fetch(imageUrl);
            
            if (!imageResponse.ok) {
              throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
            }
            
            const arrayBuffer = await imageResponse.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            
            const processedBuffer = await processImageWithSharp(imageBuffer, options);
            
            results.success.push({
              imageId,
              processingTime: `${Date.now() - startTime}ms`,
              message: 'Crawled image processed successfully (download processed image for use)',
              size: processedBuffer.length,
              uploaded: false,
              originalUrl: imageUrl
            });
            
          } catch (downloadError: any) {
            throw new Error(`Failed to process crawled image: ${downloadError.message}`);
          }
          
        } else if (parts[0] === 'wp' || parts[0] === 'media') {
          // WordPress image handling
          const websiteId = parts[1];
          const website = websiteMap.get(websiteId);
          
          if (!website || !website.url) {
            throw new Error('Website not found or URL not configured');
          }
          
          const baseUrl = website.url.replace(/\/$/, '');
          let imageUrl: string | null = null;
          let mediaId: string | null = null;
          let imageName: string = 'processed-image.jpg';
          
          if (parts[0] === 'media') {
            mediaId = parts[2];
            const mediaUrl = `${baseUrl}/wp-json/wp/v2/media/${mediaId}`;
            
            const response = await fetch(mediaUrl);
            if (response.ok) {
              const media = await response.json();
              imageUrl = media.source_url;
              imageName = media.slug ? `${media.slug}-processed.jpg` : 'processed-image.jpg';
            }
          } else if (parts[0] === 'wp') {
            const postId = parts[2];
            const postUrl = `${baseUrl}/wp-json/wp/v2/posts/${postId}?_embed`;
            
            const headers: any = {};
            if (website.wpApplicationPassword) {
              const username = website.wpUsername || website.wpApplicationName || 'admin';
              const authString = `${username}:${website.wpApplicationPassword}`;
              headers['Authorization'] = `Basic ${Buffer.from(authString).toString('base64')}`;
            }
            
            const response = await fetch(postUrl, { headers });
            if (response.ok) {
              const post = await response.json();
              
              if (parts[3] === 'featured' && post._embedded?.['wp:featuredmedia']?.[0]) {
                const media = post._embedded['wp:featuredmedia'][0];
                imageUrl = media.source_url;
                mediaId = media.id;
                imageName = media.slug ? `${media.slug}-processed.jpg` : 'processed-image.jpg';
              } else {
                const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
                const matches = [...(post.content?.rendered || '').matchAll(imgRegex)];
                const imageIndex = parseInt(parts[3] || '0');
                
                if (matches[imageIndex]) {
                  imageUrl = matches[imageIndex][1];
                  
                  const authString = website.wpApplicationPassword && website.wpUsername
                    ? `Basic ${Buffer.from(`${website.wpUsername}:${website.wpApplicationPassword}`).toString('base64')}`
                    : undefined;
                  
                  mediaId = await findMediaIdFromUrl(baseUrl, imageUrl, authString);
                  
                  if (mediaId) {
                    console.log(`  Found media ID ${mediaId} for content image`);
                    const mediaResponse = await fetch(`${baseUrl}/wp-json/wp/v2/media/${mediaId}`);
                    if (mediaResponse.ok) {
                      const media = await mediaResponse.json();
                      imageName = media.slug ? `${media.slug}-processed.jpg` : 'processed-image.jpg';
                    }
                  } else {
                    console.log(`  Could not find media ID for content image`);
                  }
                }
              }
            }
          }
          
          if (imageUrl) {
            console.log(`  Downloading image from: ${imageUrl}`);
            const imageResponse = await fetch(imageUrl);
            
            if (!imageResponse.ok) {
              throw new Error(`Failed to download image: ${imageResponse.statusText}`);
            }
            
            const arrayBuffer = await imageResponse.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            
            const processedBuffer = await processImageWithSharp(imageBuffer, options);
            
            let uploadSuccess = false;
            let newImageUrl = imageUrl;
            let uploadErrorMessage = '';
            
            if (mediaId && website.wpApplicationPassword && website.wpUsername) {
              console.log(`  Uploading processed image back to WordPress (Media ID: ${mediaId})`);
              
              try {
                const username = website.wpUsername || website.wpApplicationName || 'admin';
                const authString = `${username}:${website.wpApplicationPassword}`;
                const authHeader = `Basic ${Buffer.from(authString).toString('base64')}`;
                
                // Debug: Verify credentials
                console.log(`  🔐 Auth info - Username: ${username}, Password length: ${website.wpApplicationPassword.length}`);
                
                // Pre-flight check: Verify we can access the media item
                console.log(`  🔍 Pre-flight: Checking media permissions...`);
                const mediaCheckUrl = `${baseUrl}/wp-json/wp/v2/media/${mediaId}?context=edit`;
                const mediaCheckResponse = await fetch(mediaCheckUrl, {
                  method: 'GET',
                  headers: {
                    'Authorization': authHeader
                  }
                });
                
                if (!mediaCheckResponse.ok) {
                  const errorData = await mediaCheckResponse.json().catch(() => null);
                  console.error(`  ❌ Pre-flight failed: ${mediaCheckResponse.status} - ${JSON.stringify(errorData)}`);
                  
                  if (mediaCheckResponse.status === 401) {
                    throw new Error(`Authentication failed. Please verify WordPress credentials are correct. Error: ${errorData?.message || 'Unauthorized'}`);
                  } else if (mediaCheckResponse.status === 403) {
                    throw new Error(`Permission denied. User '${username}' cannot edit media ID ${mediaId}. Error: ${errorData?.message || 'Forbidden'}`);
                  } else {
                    throw new Error(`Cannot access media item: ${mediaCheckResponse.status} - ${errorData?.message || 'Unknown error'}`);
                  }
                }
                
                const mediaCheck = await mediaCheckResponse.json();
                console.log(`  ✅ Pre-flight passed - Can edit media: ${mediaCheck.title?.rendered || 'Untitled'}`);
                
                // Step 1: Upload the file
                const form = new FormData();
                form.append('file', processedBuffer, {
                  filename: imageName,
                  contentType: 'image/jpeg'
                });
                
                const uploadUrl = `${baseUrl}/wp-json/wp/v2/media/${mediaId}`;
                console.log(`  📤 Step 1: Uploading file to: ${uploadUrl}`);
                
                const uploadResponse = await fetch(uploadUrl, {
                  method: 'POST',
                  headers: {
                    ...form.getHeaders(),
                    'Authorization': authHeader
                  },
                  body: form as any
                });
                
                if (uploadResponse.ok) {
                  const updatedMedia = await uploadResponse.json();
                  newImageUrl = updatedMedia.source_url || updatedMedia.guid?.rendered || imageUrl;
                  
                  console.log(`  ✅ File uploaded successfully`);
                  console.log(`  📍 New URL: ${newImageUrl}`);
                  
                  // Step 2: Update SEO-optimized metadata (if not stripping)
                  if (options.action !== 'strip') {
                    console.log(`  📝 Step 2: Updating SEO-optimized metadata...`);
                    
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    // Generate SEO-friendly filename suggestion
                    let seoFilename = imageName;
                    if (options.seoDescription || options.imageDescription) {
                      const descText = options.seoDescription || options.imageDescription;
                      seoFilename = descText
                        .toLowerCase()
                        .replace(/[^a-z0-9\s-]/g, '')
                        .trim()
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .substring(0, 60)
                        + '.jpg';
                    }
                    
                    // Build comprehensive ALT text for SEO (60-125 characters recommended)
                    let altText = '';
                    if (options.seoDescription) {
                      altText = options.seoDescription;
                    } else if (options.imageDescription) {
                      altText = options.imageDescription;
                    }
                    
                    // Add location if provided (helps with local SEO)
                    if (options.seoLocation && altText) {
                      altText += ` in ${options.seoLocation}`;
                    } else if (options.seoLocation) {
                      altText = `Property in ${options.seoLocation}`;
                    }
                    
                    // Add author credit
                    if (options.author && altText) {
                      altText += ` - Photo by ${options.author}`;
                    } else if (options.author) {
                      altText = `Photo by ${options.author}`;
                    }
                    
                    // Ensure alt text is within recommended length for SEO
                    if (altText.length > 125) {
                      altText = altText.substring(0, 122) + '...';
                    }
                    
                    // Title should be descriptive and keyword-rich
                    let titleText = options.seoTitle || 
                                    options.seoDescription || 
                                    options.imageDescription || 
                                    imageName.replace(/-processed\.jpg$/, '').replace(/-/g, ' ');
                    
                    // Caption with description and copyright
                    let captionText = '';
                    if (options.seoDescription || options.imageDescription) {
                      captionText = `<p>${options.seoDescription || options.imageDescription}</p>`;
                    }
                    if (options.copyright) {
                      captionText += `<p>${options.copyright}</p>`;
                    }
                    
                    // Description field - comprehensive info for search engines
                    let descriptionText = `<p>`;
                    if (options.seoDescription || options.imageDescription) {
                      descriptionText += `${options.seoDescription || options.imageDescription}. `;
                    }
                    if (options.seoLocation) {
                      descriptionText += `Located in ${options.seoLocation}. `;
                    }
                    descriptionText += `Processed by AI Content Manager on ${new Date().toLocaleDateString()}.`;
                    if (options.copyright) {
                      descriptionText += `<br>Copyright: ${options.copyright}`;
                    }
                    if (options.author) {
                      descriptionText += `<br>Photographer: ${options.author}`;
                    }
                    if (options.seoKeywords) {
                      descriptionText += `<br>Keywords: ${options.seoKeywords}`;
                    }
                    descriptionText += `</p>`;
                    
                    const metadataPayload = {
                      title: titleText,
                      alt_text: altText,
                      caption: captionText,
                      description: descriptionText
                    };
                    
                    console.log(`  📋 SEO-optimized metadata:`, {
                      title: titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
                      alt_text: altText,
                      suggested_filename: seoFilename,
                      seo_score: altText.length >= 60 && altText.length <= 125 ? '✅ Good' : '⚠️ Could be better'
                    });
                    
                    const metadataResponse = await fetch(uploadUrl, {
                      method: 'POST',
                      headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify(metadataPayload)
                    });
                    
                    if (metadataResponse.ok) {
                      console.log(`  ✅ SEO metadata updated successfully`);
                      if (options.seoDescription || options.imageDescription) {
                        console.log(`  💡 SEO tip: Suggested filename for better ranking: ${seoFilename}`);
                      }
                    } else {
                      const metaError = await metadataResponse.text();
                      console.error(`  ⚠️ Metadata update failed: ${metadataResponse.status} - ${metaError}`);
                    }
                  }
                  
                  uploadSuccess = true;
                  console.log(`  🎉 WordPress update complete!`);
                  
                } else {
                  const errorText = await uploadResponse.text();
                  let errorData;
                  try {
                    errorData = JSON.parse(errorText);
                  } catch {
                    errorData = { message: errorText };
                  }
                  
                  console.error(`  ❌ WordPress upload failed: ${uploadResponse.status}`);
                  console.error(`  📄 Error details:`, errorData);
                  
                  uploadErrorMessage = `WordPress upload failed (${uploadResponse.status}): ${errorData.message || errorText}`;
                  
                  if (uploadResponse.status === 401) {
                    uploadErrorMessage = `Authentication failed. Credentials may have changed. Error: ${errorData.message}`;
                  } else if (uploadResponse.status === 403) {
                    uploadErrorMessage = `Permission denied. User '${username}' cannot edit this media item. Error: ${errorData.message}`;
                  }
                }
              } catch (uploadError: any) {
                console.error(`  ❌ Upload error: ${uploadError.message}`);
                uploadErrorMessage = uploadError.message;
              }
            } else if (!mediaId) {
              console.log(`  ℹ️ No media ID - cannot update WordPress`);
              uploadErrorMessage = 'No media ID available';
            } else if (!website.wpApplicationPassword || !website.wpUsername) {
              console.log(`  ⚠️ WordPress credentials not configured`);
              uploadErrorMessage = 'WordPress credentials not configured';
            }
            
            results.success.push({
              imageId,
              processingTime: `${Date.now() - startTime}ms`,
              message: uploadSuccess 
                ? 'Image processed and uploaded to WordPress with SEO optimization' 
                : `Image processed successfully (WordPress update failed: ${uploadErrorMessage})`,
              size: processedBuffer.length,
              uploaded: uploadSuccess,
              wordpressUrl: newImageUrl,
              uploadError: uploadSuccess ? undefined : uploadErrorMessage
            });
          } else {
            throw new Error('Could not determine image URL');
          }
        } else {
          throw new Error(`Unknown image type: ${parts[0]}`);
        }
        
      } catch (error: any) {
        console.error(`❌ Failed to process ${imageId}:`, error.message);
        results.failed.push(imageId);
        results.errors.push({
          imageId,
          message: error.message || 'Unknown error',
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
      }
    }
    
    const successCount = results.success.length;
    const uploadedCount = results.success.filter(r => r.uploaded).length;
    const failedCount = results.failed.length;
    const successRate = `${Math.round((successCount / imageIds.length) * 100)}%`;
    
    const response = {
      total: imageIds.length,
      processed: successCount,
      uploaded: uploadedCount,
      failed: failedCount,
      successRate,
      processingTime: `${Date.now()}ms`,
      results: {
        success: results.success,
        failed: results.failed
      },
      message: uploadedCount > 0 
        ? `Processed ${successCount} images with SEO optimization, uploaded ${uploadedCount} to WordPress`
        : `Processed ${successCount} of ${imageIds.length} images`,
      errors: results.errors.length > 0 ? results.errors : undefined
    };
    
    console.log(`✅ Batch processing complete: ${successCount}/${imageIds.length} successful, ${uploadedCount} uploaded to WordPress`);
    
    res.json(response);
    
  } catch (error: any) {
    console.error("❌ Failed to process images:", error);
    res.status(500).json({ 
      error: 'Failed to process images',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});






  app.post("/api/images/crawl", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { url, options } = req.body;
      
      console.log(`🕷️ Starting web crawl for: ${url}`);
      
      // Validate URL
      let validUrl: URL;
      try {
        validUrl = new URL(url);
        if (!['http:', 'https:'].includes(validUrl.protocol)) {
          throw new Error('Invalid protocol');
        }
      } catch {
        res.status(400).json({
          error: 'Invalid URL',
          message: 'Please provide a valid HTTP(S) URL',
        });
        return;
      }
      
      // Crawl options
      const maxDepth = options?.maxDepth || 2;
      const maxImages = options?.maxImages || 50;
      const minWidth = options?.minWidth || 200;
      const minHeight = options?.minHeight || 200;
      
      const visitedUrls = new Set<string>();
      const crawledImages: any[] = [];
      
      async function crawlPage(pageUrl: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;
        if (crawledImages.length >= maxImages) return;
        if (visitedUrls.has(pageUrl)) return;
        
        visitedUrls.add(pageUrl);
        
        try {
          console.log(`  Crawling: ${pageUrl} (depth: ${depth})`);
          
          const response = await fetch(pageUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; ImageCrawler/1.0)',
            },
            signal: AbortSignal.timeout(10000),
          });
          
          if (!response.ok) return;
          
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) return;
          
          const html = await response.text();
          const dom = new JSDOM(html, { url: pageUrl });
          const document = dom.window.document;
          
          // Get page title
          const pageTitle = document.querySelector('title')?.textContent || '';
          
          // Extract images
          const images = document.querySelectorAll('img');
          for (const img of images) {
            if (crawledImages.length >= maxImages) break;
            
            const imgSrc = img.src;
            if (!imgSrc || imgSrc.startsWith('data:')) continue;
            
            // Resolve relative URLs
            let imgUrl: string;
            try {
              imgUrl = new URL(imgSrc, pageUrl).href;
            } catch {
              continue;
            }
            
            // Skip if already crawled
            if (crawledImages.some(ci => ci.url === imgUrl)) continue;
            
            // Check dimensions if specified in HTML
            const width = parseInt(img.getAttribute('width') || '0');
            const height = parseInt(img.getAttribute('height') || '0');
            
            // Only skip if both minWidth and minHeight are set AND image doesn't meet them
            if (minWidth > 0 && width > 0 && width < minWidth) continue;
            if (minHeight > 0 && height > 0 && height < minHeight) continue;
            
            // Skip data URLs if they're too small (but still allow them)
            if (imgSrc.startsWith('data:') && imgSrc.length < 100) continue;
            
            crawledImages.push({
              url: imgUrl,
              alt: img.alt || undefined,
              title: img.title || undefined,
              width: width || undefined,
              height: height || undefined,
              pageUrl,
              pageTitle,
              depth,
            });
            
            console.log(`    Found image: ${imgUrl}`);
          }
          
          // Extract links for further crawling
          if (depth < maxDepth) {
            const links = document.querySelectorAll('a[href]');
            const uniqueLinks = new Set<string>();
            
            for (const link of links) {
              const href = link.getAttribute('href');
              if (!href) continue;
              
              try {
                const linkUrl = new URL(href, pageUrl);
                
                // Only follow same-origin links by default
                if (linkUrl.origin !== validUrl.origin && !options?.followExternal) continue;
                
                // Skip non-HTTP(S) protocols
                if (!['http:', 'https:'].includes(linkUrl.protocol)) continue;
                
                // Skip common non-content URLs but KEEP WordPress post/page URLs
                const skipPatterns = [
                  '/wp-admin', '/wp-login', '/feed/', '.pdf', '.zip', '.doc',
                  'mailto:', 'javascript:', '/wp-json/', '#respond', '#comments'
                ];
                
                let shouldSkip = false;
                for (const pattern of skipPatterns) {
                  if (linkUrl.href.includes(pattern)) {
                    shouldSkip = true;
                    break;
                  }
                }
                
                if (!shouldSkip) {
                  // Clean up URL (remove fragments)
                  linkUrl.hash = '';
                  uniqueLinks.add(linkUrl.href);
                }
              } catch {
                continue;
              }
            }
            
            // Prioritize post/page URLs
            const sortedLinks = Array.from(uniqueLinks).sort((a, b) => {
              // Prioritize individual posts/pages
              const aIsPost = a.match(/\/([\w-]+)\/?$/);
              const bIsPost = b.match(/\/([\w-]+)\/?$/);
              if (aIsPost && !bIsPost) return -1;
              if (!aIsPost && bIsPost) return 1;
              return 0;
            });
            
            // Crawl discovered links
            for (const linkUrl of sortedLinks) {
              if (crawledImages.length >= maxImages) break;
              await crawlPage(linkUrl, depth + 1);
            }
          }
          
        } catch (error: any) {
          console.error(`  Error crawling ${pageUrl}:`, error.message);
        }
      }
      
      // Start crawling
      await crawlPage(validUrl.href, 0);
      
      console.log(`✅ Crawl complete: Found ${crawledImages.length} images`);
      
      // Transform to match frontend format
      const transformedImages = crawledImages.map((img, index) => ({
        id: `crawled_${Date.now()}_${index}`,
        url: img.url,
        contentId: `crawl_${index}`,
        contentTitle: img.pageTitle || `Page: ${new URL(img.pageUrl).pathname}`,
        websiteId: 'crawled',
        websiteName: validUrl.hostname,
        hasMetadata: false,
        metadataDetails: {
          alt: img.alt,
          title: img.title,
          width: img.width,
          height: img.height,
        },
        size: 0,
        createdAt: new Date().toISOString(),
        isAIGenerated: false,
        isCrawled: true,
        source: img.pageUrl,
      }));
      
      res.json({
        success: true,
        images: transformedImages,
        stats: {
          totalImages: crawledImages.length,
          pagesVisited: visitedUrls.size,
          maxDepthReached: Math.max(...crawledImages.map(i => i.depth), 0),
        },
      });
      
    } catch (error: any) {
      console.error('Crawl error:', error);
      res.status(500).json({
        error: 'Crawl failed',
        message: error.message,
      });
    }
  });


app.get("/api/images/batch-process", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { contentId } = req.query;
      
      if (!contentId) {
        res.status(400).json({ 
          error: 'Content ID required' 
        });
        return;
      }
      
      res.json({
        status: 'ready',
        contentId: contentId,
        message: 'Image processing available'
      });
      
    } catch (error: any) {
      console.error("⌠Failed to get image status:", error);
      res.status(500).json({ 
        error: 'Failed to get image status',
        message: error.message
      });
    }
  });

 app.post("/api/user/content/upload-images", 
  requireAuth, 
  upload.array('images', 10), 
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const { websiteId, contentId } = req.body;
      const files = req.files as Express.Multer.File[];
      
      const uploadedImages = [];
      
      for (const file of files) {
        try {
          // Step 3: Optimize image with Sharp
          const optimizedBuffer = await sharp(file.buffer)
            .resize(1920, 1080, { 
              fit: 'inside', 
              withoutEnlargement: true 
            })
            .jpeg({ 
              quality: 85, 
              progressive: true 
            })
            .toBuffer();
          
          // Get metadata for dimensions
          const metadata = await sharp(optimizedBuffer).metadata();
          
          // Upload optimized image to Cloudinary
          const cloudinaryResult = await cloudinaryStorage.uploadFromBuffer(
            optimizedBuffer,  // Use optimized buffer instead of original
            websiteId,
            contentId || 'user-upload',
            file.originalname
          );
          
          // Step 2: Save to database
          const imageRecord = await storage.createContentImage({
            userId,
            contentId: contentId || null,
            websiteId,
            url: cloudinaryResult.secureUrl,
            cloudinaryId: cloudinaryResult.publicId,
            altText: file.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
            filename: file.originalname,
            mimeType: 'image/jpeg',  // We converted to JPEG
            size: optimizedBuffer.length,
            width: metadata.width || 0,
            height: metadata.height || 0,
            source: 'user_upload'
          });
          
          uploadedImages.push({
            id: imageRecord.id,
            url: cloudinaryResult.secureUrl,
            publicId: cloudinaryResult.publicId,
            altText: imageRecord.altText,
            filename: file.originalname,
            size: optimizedBuffer.length,
            width: metadata.width,
            height: metadata.height
          });
          
        } catch (uploadError: any) {
          console.error(`Failed to process ${file.originalname}:`, uploadError);
        }
      }
      
      res.json({
        success: true,
        images: uploadedImages,
        message: `Uploaded ${uploadedImages.length} images`
      });
      
    } catch (error: any) {
      console.error('❌ Upload error:', error);
      res.status(500).json({ 
        error: 'Upload failed',
        message: error.message 
      });
    }
  }
);

app.post("/api/user/content/replace-image", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { contentId, oldImageUrl, newImageUrl, newAltText } = req.body;
    
    // Validate content ownership
    const content = await storage.getContent(contentId);
    if (!content || content.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    
    // Replace image in content body
    const imgRegex = new RegExp(
      `<img[^>]*src=["']${escapeRegExp(oldImageUrl)}["'][^>]*>`, 
      'gi'
    );
    
    const updatedBody = content.body.replace(imgRegex, (match) => {
      return match
        .replace(/src=["'][^"']+["']/, `src="${newImageUrl}"`)
        .replace(/alt=["'][^"']*["']/, `alt="${newAltText}"`);
    });
    
    // Update content
    await storage.updateContent(contentId, {
      body: updatedBody,
      updatedAt: new Date()
    });
    
    res.json({
      success: true,
      message: 'Image replaced successfully'
    });
    
  } catch (error: any) {
    console.error('Failed to replace image:', error);
    res.status(500).json({ error: 'Failed to replace image' });
  }
});

// Get user's image library
app.get("/api/user/content/images", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { websiteId, contentId, limit = "50", offset = "0" } = req.query;
    
    const images = await storage.getUserContentImages(userId, {
      websiteId: websiteId as string,
      contentId: contentId as string,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string)
    });
    
    res.json({
      images,
      total: images.length,
      hasMore: images.length === parseInt(limit as string)
    });
    
  } catch (error: any) {
    console.error('Failed to fetch images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// Delete image
app.delete("/api/user/content/images/:imageId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { imageId } = req.params;
    
    // Get image to verify ownership and get cloudinary ID
    const image = await storage.getContentImage(imageId);
    if (!image || image.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    
    // Delete from Cloudinary if it has a public ID
    if (image.cloudinaryId) {
      await cloudinaryStorage.deleteImage(image.cloudinaryId);
    }
    
    // Delete from database
    await storage.deleteContentImage(imageId);
    
    res.json({
      success: true,
      message: 'Image deleted successfully'
    });
    
  } catch (error: any) {
    console.error('Failed to delete image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

  // ===========================================================================
  // BILLING ROUTES
  // ===========================================================================
  
// app.use('/api/billing', billingRouter);


  // ===========================================================================
  // NANO BANANA SERVICE ROUTES
  // ===========================================================================
  
app.use('/api/nano-banana-imagen', nanoBananaImagenRoutes);

app.use("/api/user/high-intent", requireAuth, highIntentRoutes);
  // ===========================================================================
  // HIGH INTENT ROUTES
  // ===========================================================================
  

app.use("/api/user/high-intent", requireAuth, highIntentRoutes);
  // ===========================================================================
  // GOOGLE SEARCH CONSOLE ROUTES
  // ===========================================================================
  
  app.use('/api/gsc', requireAuth, gscRouter);

  // ===========================================================================
  // DASHBOARD & ACTIVITY ROUTES
  // ===========================================================================
  
 app.get("/api/user/dashboard/stats", requireAuth, async (req: Request, res: Response): Promise<void> => { try { const userId = req.user!.id; const websiteId = req.query.websiteId as string | undefined; if (websiteId) { 
  // Verify ownership first 
  const website = await storage.getUserWebsite(websiteId, userId); 
  if (!website) { res.status(404).json({ message: "Website not found or access denied" }); return; } 
  // Pass userId to ensure we only get this user's reports 
  const reports = await storage.getSeoReportsByWebsite(websiteId, userId);
  const sortedReports = reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ); 
  // Get content for this website (also filtered by user) 
  const contents = await storage.getUserContent(userId, websiteId);
   const scheduledCount = contents.filter((c: any) => c.status === 'scheduled' || c.scheduledAt ).length; 
   const currentScore = sortedReports.length > 0 ? (sortedReports[0].score || 0) : 0; 
   const previousScore = sortedReports.length > 1 ? (sortedReports[1].score || null) : null; 
   res.json({ websiteCount: 1, contentCount: contents.length, avgSeoScore: currentScore, previousAvgSeoScore: previousScore, scheduledPosts: scheduledCount, reportCount: reports.length }); 
  } 
  else 
    { 
      // Get overall stats 
      const stats = await storage.getUserDashboardStats(userId); res.json(stats);
     } 
    } 
    catch (error) 
    { console.error("Failed to fetch dashboard stats:", error); 
      res.status(500).json({ message: "Failed to fetch dashboard stats" }); 
    } 
  }); 
  
  
 app.get("/api/user/dashboard/performance", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    // Get user's websites
    const websites = await storage.getUserWebsites(userId);
    
    if (websites.length === 0) {
      res.json({
        data: [],
        websites: [],
        hasData: false,
        totalReports: 0,
        lastFetch: new Date().toISOString(),
      });
      return;
    }

    const allDataPoints = [];
    const websiteInfo = [];
    const LINE_COLORS = [
      "#3b82f6", "#10b981", "#f59e0b", "#ef4444", 
      "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"
    ];
    
    let totalReports = 0;

    // Process each website
    for (let i = 0; i < websites.length; i++) {
      const website = websites[i];
      
      try {
        // Get SEO reports for this website
        const reports = await storage.getSeoReportsByWebsite(website.id, userId);
        
        if (reports && reports.length > 0) {
          totalReports += reports.length;

          // Sort reports chronologically
          const sortedReports = [...reports].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );

          const latestReport = sortedReports[sortedReports.length - 1];
          
          // Add website info for legend
          websiteInfo.push({
            id: website.id,
            name: website.name,
            color: LINE_COLORS[i % LINE_COLORS.length],
            latestScore: latestReport?.score || 0,
            reportCount: reports.length,
          });

          // Create data points for each report
          for (const report of sortedReports) {
            const ts = new Date(report.createdAt).getTime();
            
            // Find existing data point or create new one
            let dataPoint = allDataPoints.find(dp => dp.ts === ts);
            
            if (!dataPoint) {
              dataPoint = {
                ts,
                label: new Intl.DateTimeFormat("en-US", {
                  timeZone: "Asia/Manila",
                  month: "short",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(new Date(report.createdAt)),
                reportId: report.id,
                metadata: {}
              };
              allDataPoints.push(dataPoint);
            }
            
            // Add the score for this website
            const score = report.score || 0;
            dataPoint[website.name] = score;
            
            // Add metadata for tooltip
            if (!dataPoint.metadata) dataPoint.metadata = {};
            dataPoint.metadata[website.name] = {
              score,
              pageSpeedScore: report.pageSpeedScore,
              issuesCount: report.fixableIssuesCount || 0,
              criticalIssues: report.criticalIssuesCount || 0,
              reportId: report.id,
              createdAt: report.createdAt,
            };
          }
        } else {
          // Website with no reports
          websiteInfo.push({
            id: website.id,
            name: website.name,
            color: LINE_COLORS[i % LINE_COLORS.length],
            latestScore: 0,
            reportCount: 0,
          });
        }
      } catch (error) {
        console.error(`Error processing website ${website.id}:`, error);
        websiteInfo.push({
          id: website.id,
          name: website.name,
          color: LINE_COLORS[i % LINE_COLORS.length],
          latestScore: 0,
          reportCount: 0,
          error: true,
        });
      }
    }

    // Sort data points by timestamp
    const sortedData = allDataPoints.sort((a, b) => a.ts - b.ts);
    
    // Keep recent data points (last 100)
    const recentData = sortedData.slice(-100);

    res.json({
      data: recentData,
      websites: websiteInfo,
      hasData: recentData.length > 0,
      totalReports,
      lastFetch: new Date().toISOString(),
    });

  } catch (error) {
    console.error("Failed to fetch performance data:", error);
    res.status(500).json({ message: "Failed to fetch performance data" });
  }
});

  app.get("/api/user/activity-logs", requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const websiteId = req.query.websiteId as string;
      
      if (websiteId) {
        const website = await storage.getUserWebsite(websiteId, userId);
        if (!website) {
          res.status(404).json({ message: "Website not found or access denied" });
          return;
        }
      }
      
      const logs = await storage.getUserActivityLogs(userId, websiteId);
      res.json(logs);
    } catch (error) {
      console.error("Failed to fetch activity logs:", error);
      res.status(500).json({ message: "Failed to fetch activity logs" });
    }
  });


// ===========================================================================
// ACTIVITY LOGS DELETE ROUTES
// ===========================================================================

// Bulk delete activity logs
app.delete("/api/user/activity-logs/bulk-delete", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ 
        success: false, 
        message: "Log IDs array is required" 
      });
      return;
    }

    // Verify all logs belong to the user before deleting
    const userLogs = await storage.getUserActivityLogsByIds(ids, userId);
    
    if (userLogs.length !== ids.length) {
      res.status(403).json({ 
        success: false, 
        message: "Some activity logs not found or access denied" 
      });
      return;
    }

    // Delete the activity logs
    const deletedCount = await storage.bulkDeleteActivityLogs(ids, userId);

    res.json({ 
      success: true, 
      message: `${deletedCount} activity logs deleted successfully`,
      deletedCount 
    });
  } catch (error) {
    console.error("Failed to bulk delete activity logs:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to delete activity logs" 
    });
  }
});

app.delete("/api/user/activity-logs/clear-all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const websiteId = req.query.websiteId as string | undefined;
    
    console.log(`Clearing logs - User: ${userId}, Website: ${websiteId || 'all'}`);

    // Only verify website if websiteId is actually provided and not empty
    if (websiteId && websiteId !== '' && websiteId !== 'undefined') {
      const website = await storage.getUserWebsite(websiteId, userId);
      if (!website) {
        res.status(404).json({ 
          success: false,
          message: "Website not found or access denied" 
        });
        return;
      }
    }

    // Clear activity logs
    const deletedCount = await storage.clearAllActivityLogs(userId, websiteId);

    res.json({ 
      success: true, 
      message: websiteId 
        ? `All activity logs for website cleared successfully` 
        : `All activity logs cleared successfully`,
      deletedCount
    });
  } catch (error) {
    console.error("Failed to clear all activity logs:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to clear activity logs" 
    });
  }
});

app.delete("/api/user/activity-logs/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const logId = req.params.id;

    if (!logId) {
      res.status(400).json({ 
        success: false, 
        message: "Activity log ID is required" 
      });
      return;
    }

    // Verify the log belongs to the user
    const activityLog = await storage.getActivityLog(logId, userId);
    
    if (!activityLog) {
      res.status(404).json({ 
        success: false, 
        message: "Activity log not found or access denied" 
      });
      return;
    }

    // Delete the activity log
    await storage.deleteActivityLog(logId, userId);

    res.json({ 
      success: true, 
      message: "Activity log deleted successfully",
      deletedId: logId 
    });
  } catch (error) {
    console.error("Failed to delete activity log:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to delete activity log" 
    });
  }
});


  // ===========================================================================
  // SYSTEM/GLOBAL ROUTES (No authentication required)
  // ===========================================================================
  
  app.get("/api/ai-providers/status", async (req: Request, res: Response): Promise<void> => {
    try {
      const status = {
        openai: {
          available: !!(process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR),
          model: 'gpt-4o',
          pricing: { input: 0.005, output: 0.015 }
        },
        anthropic: {
          available: !!process.env.ANTHROPIC_API_KEY,
          model: 'claude-3-5-sonnet-20241022',
          pricing: { input: 0.003, output: 0.015 }
        },
        gemini: {
          available: !!process.env.GOOGLE_GEMINI_API_KEY,
          model: 'gemini-1.5-pro',
          pricing: { input: 0.0025, output: 0.0075 }
        },
        pagespeed: {
          available: !!process.env.GOOGLE_PAGESPEED_API_KEY
        }
      };

      res.json({
        success: true,
        providers: status
      });
    } catch (error) {
      console.error('Provider status check error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: 'Failed to check provider status',
        message: errorMessage
      });
    }
  });

  app.get("/api/seo/health", async (req: Request, res: Response): Promise<void> => {
    try {
      const hasGoogleApiKey = !!process.env.GOOGLE_PAGESPEED_API_KEY;
      const hasOpenAI = !!process.env.OPENAI_API_KEY;
      const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
      const hasGemini = !!process.env.GOOGLE_GEMINI_API_KEY;
      
      const availableProviders = [];
      if (hasOpenAI) availableProviders.push('OpenAI GPT-4');
      if (hasAnthropic) availableProviders.push('Anthropic Claude');
      if (hasGemini) availableProviders.push('Google Gemini');
      
      res.json({
        status: "healthy",
        services: {
          pageSpeedInsights: {
            configured: hasGoogleApiKey,
            message: hasGoogleApiKey 
              ? "Google PageSpeed Insights API is configured" 
              : "Using fallback speed estimation (configure GOOGLE_PAGESPEED_API_KEY for better results)"
          },
          technicalAnalysis: {
            configured: true,
            message: "Technical SEO analysis is fully operational"
          },
          aiContentAnalysis: {
            configured: hasOpenAI || hasAnthropic || hasGemini,
            providers: {
              openai: hasOpenAI,
              anthropic: hasAnthropic,
              gemini: hasGemini
            },
            message: availableProviders.length > 0
              ? `AI content analysis available via ${availableProviders.join(', ')}` 
              : "Configure OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GEMINI_API_KEY for AI-powered content analysis"
          }
        },
        capabilities: {
          basicSEO: true,
          technicalSEO: true,
          pageSpeed: hasGoogleApiKey,
          contentQuality: hasOpenAI || hasAnthropic || hasGemini,
          keywordOptimization: hasOpenAI || hasAnthropic || hasGemini,
          eatScoring: hasOpenAI || hasAnthropic || hasGemini,
          contentGapAnalysis: hasOpenAI || hasAnthropic || hasGemini,
          semanticAnalysis: hasOpenAI || hasAnthropic || hasGemini,
          userIntentAlignment: hasOpenAI || hasAnthropic || hasGemini
        }
      });
    } catch (error) {
      console.error("SEO health check failed:", error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ 
        status: "unhealthy", 
        error: errorMessage 
      });
    }
  });

  app.post("/api/validate-url", async (req: Request, res: Response): Promise<void> => {
    try {
      const { url } = req.body;
      
      if (!url) {
        res.status(400).json({ 
          valid: false, 
          error: "URL is required" 
        });
        return;
      }

      try {
        new URL(url);
        res.json({
          valid: true,
          url: url,
          message: "URL format is valid"
        });
      } catch {
        res.json({
          valid: false,
          error: "Invalid URL format",
          message: "Please enter a valid URL starting with http:// or https://"
        });
      }
    } catch (error) {
      console.error("URL validation error:", error);
      res.status(500).json({ 
        valid: false, 
        error: "URL validation failed" 
      });
    }
  });

  // ===========================================================================
  // CREATE HTTP SERVER
  // ===========================================================================
  
  const httpServer = createServer(app);
  return httpServer;
}

// Export the requireAuth middleware for use in other files
export { requireAuth };



